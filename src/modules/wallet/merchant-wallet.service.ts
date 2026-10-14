// src/modules/wallet/merchant-wallet.service.ts
import { supabaseAdmin } from '../../config/supabase';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../config/logger';
import { notificationService } from '../notification/notification.service';

// ============================================================
// KONFIGURASI
// ============================================================
// Komisi merchant hanya untuk order FOOD, dihitung dari subtotal makanan.
// Tarif diambil dari RPC get_commission_rate yang sama dengan driver.
// Kalau mau tarif merchant terpisah, ganti nilai di bawah (mis. 'food_merchant')
// dan tambahkan barisnya di tabel tarif.
const MERCHANT_COMMISSION_ORDER_TYPE = 'food';
const DEFAULT_MERCHANT_COMMISSION = 0.12;

// Batas utang komisi cash. Lewat batas ini toko tidak boleh menerima order cash baru.
export const MERCHANT_DEBT_LIMIT = Number(process.env.MERCHANT_DEBT_LIMIT ?? 100000);
// Saldo bersih minimal agar toko boleh buka/online.
export const MERCHANT_MIN_BALANCE = Number(process.env.MERCHANT_MIN_BALANCE ?? 20000);

// ============================================================
// TYPES
// ============================================================
type MerchantWalletRow = {
    user_id: string;
    balance: number;
    cash_debt: number;
    total_earning: number;
    total_commission_paid: number;
    total_commission_owed: number;
    updated_at: string;
};

type LedgerDraft = {
    entry_type: string;
    amount: number;
    direction: 'in' | 'out';
    balance_after: number;
    cash_debt_after: number;
    description: string;
    metadata?: Record<string, any>;
};

export type MerchantWallet = {
    balance: number;
    cash_debt: number;
    net_balance: number;
    pending_payout: number;
    total_earning: number;
    total_commission_paid: number;
    total_commission_owed: number;
    debt_limit: number;
    can_accept_cash_orders: boolean;
    updated_at: string;
};

const rp = (n: number) => `Rp${n.toLocaleString('id-ID')}`;

// ============================================================
// SERVICE
// ============================================================
class MerchantWalletService {
    // ----------------------------------------------------------
    // Helper: identitas merchant
    // ----------------------------------------------------------
    async isMerchantUser(userId: string): Promise<boolean> {
        const { data } = await supabaseAdmin
            .from('profiles')
            .select('role')
            .eq('id', userId)
            .maybeSingle();
        return (data as any)?.role === 'merchant';
    }

    // orders.merchant_id -> user pemilik toko.
    // ASUMSI: tabel merchants punya kolom owner_id. Kalau tabelnya tidak ada /
    // tidak ketemu, merchant_id dianggap sudah berupa user id.
    private async resolveMerchantUserId(merchantId: string): Promise<string> {
        try {
            const { data } = await supabaseAdmin
                .from('merchants')
                .select('owner_id')
                .eq('id', merchantId)
                .maybeSingle();
            const ownerId = (data as any)?.owner_id;
            if (ownerId) return String(ownerId);
        } catch {
            /* fallback di bawah */
        }
        return merchantId;
    }

    private async getRate(): Promise<number> {
        const { data, error } = await supabaseAdmin.rpc('get_commission_rate', {
            p_order_type: MERCHANT_COMMISSION_ORDER_TYPE,
            p_tariff_code: null,
        });
        if (error || data == null) {
            logger.warn('Gagal ambil commission rate merchant, pakai default', { error });
            return DEFAULT_MERCHANT_COMMISSION;
        }
        return Number(data);
    }

    private async ensureWallet(userId: string) {
        await supabaseAdmin
            .from('merchant_wallets')
            .upsert({ user_id: userId }, { onConflict: 'user_id', ignoreDuplicates: true });
    }

    // ----------------------------------------------------------
    // Inti: baca wallet -> hitung -> update dengan optimistic lock.
    // Kalau wallet berubah di tengah jalan (updated_at beda), ulangi.
    // ----------------------------------------------------------
    private async mutate<T>(
        userId: string,
        orderId: number | null,
        compute: (w: MerchantWalletRow) => {
            patch: Record<string, number>;
            ledger: LedgerDraft[];
            result: T;
        }
    ): Promise<T> {
        for (let attempt = 1; attempt <= 5; attempt++) {
            await this.ensureWallet(userId);

            const { data, error } = await supabaseAdmin
                .from('merchant_wallets')
                .select('*')
                .eq('user_id', userId)
                .single();
            if (error || !data) throw ApiError.internal('Wallet merchant tidak ditemukan');

            const w = data as unknown as MerchantWalletRow;
            const { patch, ledger, result } = compute(w);

            const { data: updated, error: uErr } = await supabaseAdmin
                .from('merchant_wallets')
                .update({ ...patch, updated_at: new Date().toISOString() })
                .eq('user_id', userId)
                .eq('updated_at', w.updated_at)
                .select('user_id');

            if (uErr) {
                logger.error('Update wallet merchant gagal', { error: uErr, userId });
                throw ApiError.internal('Gagal update wallet merchant');
            }
            if (!updated || updated.length === 0) continue; // wallet berubah, ulangi

            if (ledger.length > 0) {
                const { error: lErr } = await supabaseAdmin
                    .from('merchant_wallet_ledger')
                    .insert(
                        ledger.map((l) => ({
                            user_id: userId,
                            order_id: orderId,
                            metadata: {},
                            ...l,
                        }))
                    );
                if (lErr) {
                    logger.error('Insert ledger merchant gagal', { error: lErr, userId, orderId });
                }
            }
            return result;
        }
        throw ApiError.internal('Wallet merchant sedang sibuk, coba lagi');
    }

    // ============================================================
    // GET WALLET
    // ============================================================
    async getWallet(userId: string): Promise<MerchantWallet> {
        await this.ensureWallet(userId);

        const { data, error } = await supabaseAdmin
            .from('merchant_wallets')
            .select('*')
            .eq('user_id', userId)
            .single();
        if (error || !data) throw ApiError.internal('Gagal ambil wallet merchant');

        const w = data as unknown as MerchantWalletRow;

        // Penarikan yang sudah memotong saldo tapi belum final di bank
        const { data: pend } = await supabaseAdmin
            .from('wallet_withdrawals')
            .select('amount')
            .eq('user_id', userId)
            .eq('status', 'PENDING');
        const pendingPayout = (pend ?? []).reduce(
            (s: number, r: any) => s + Number(r.amount ?? 0),
            0
        );

        const balance = Number(w.balance);
        const cashDebt = Number(w.cash_debt);

        return {
            balance,
            cash_debt: cashDebt,
            net_balance: balance - cashDebt,
            pending_payout: pendingPayout,
            total_earning: Number(w.total_earning),
            total_commission_paid: Number(w.total_commission_paid),
            total_commission_owed: Number(w.total_commission_owed),
            debt_limit: MERCHANT_DEBT_LIMIT,
            can_accept_cash_orders: cashDebt < MERCHANT_DEBT_LIMIT,
            updated_at: w.updated_at,
        };
    }

    // ============================================================
    // ELIGIBILITY — dipanggil saat assign order / toko buka
    // ============================================================
    async getEligibility(userId: string) {
        const w = await this.getWallet(userId);
        const canCash = w.cash_debt < MERCHANT_DEBT_LIMIT;
        const canOnline = canCash && w.net_balance >= MERCHANT_MIN_BALANCE;

        let reason: string | null = null;
        if (!canCash) {
            reason = `Utang komisi ${rp(w.cash_debt)} melewati batas ${rp(MERCHANT_DEBT_LIMIT)}. Top up untuk melunasi.`;
        } else if (!canOnline) {
            reason = `Saldo bersih minimal ${rp(MERCHANT_MIN_BALANCE)} agar toko bisa menerima pesanan.`;
        }
        return {
            can_accept_cash_orders: canCash,
            can_go_online: canOnline,
            debt_limit: MERCHANT_DEBT_LIMIT,
            min_balance: MERCHANT_MIN_BALANCE,
            reason,
        };
    }

    // ============================================================
    // SETTLE ORDER — potong komisi merchant (idempotent, tidak pernah throw)
    // ============================================================
    async settleOrder(orderId: number) {
        try {
            const { data: o, error } = await supabaseAdmin
                .from('orders')
                .select('id, type, status, payment_method, subtotal, merchant_id, merchant_settled_at')
                .eq('id', orderId)
                .single();

            if (error || !o) {
                logger.warn('[merchantSettle] order tidak ditemukan', { orderId });
                return null;
            }
            const order = o as any;

            if (order.type !== 'food' || order.status !== 'completed') return null;
            if (order.merchant_settled_at) return null;
            if (!order.merchant_id) {
                logger.warn('[merchantSettle] order food tanpa merchant_id', { orderId });
                return null;
            }

            const gross = Number(order.subtotal) || 0;
            if (gross <= 0) return null;

            // Klaim atomik: hanya satu proses yang boleh lanjut
            const nowIso = new Date().toISOString();
            const { data: claimed } = await supabaseAdmin
                .from('orders')
                .update({ merchant_settled_at: nowIso })
                .eq('id', orderId)
                .is('merchant_settled_at', null)
                .select('id');
            if (!claimed || claimed.length === 0) return null;

            const rate = await this.getRate();
            const commission = Math.round(gross * rate);
            const earning = gross - commission;
            const isCash = order.payment_method === 'cash';
            const merchantUserId = await this.resolveMerchantUserId(String(order.merchant_id));

            let result: { balance: number; cash_debt: number; to_debt: number; debt_paid: number };

            try {
                result = await this.mutate(merchantUserId, orderId, (w) => {
                    const balance = Number(w.balance);
                    const debt = Number(w.cash_debt);

                    if (isCash) {
                        // ── CASH: uang sudah di tangan toko. Komisi ditagih ke toko.
                        // Potong saldo dulu; kekurangannya jadi utang.
                        const fromBalance = Math.min(balance, commission);
                        const toDebt = commission - fromBalance;
                        const newBalance = balance - fromBalance;
                        const newDebt = debt + toDebt;

                        return {
                            patch: {
                                balance: newBalance,
                                cash_debt: newDebt,
                                total_earning: Number(w.total_earning) + earning,
                                total_commission_paid:
                                    Number(w.total_commission_paid) + fromBalance,
                                total_commission_owed: newDebt,
                            },
                            ledger: [
                                {
                                    entry_type: 'commission_cash',
                                    amount: commission,
                                    direction: 'out',
                                    balance_after: newBalance,
                                    cash_debt_after: newDebt,
                                    description: `Komisi order #${orderId} (${(rate * 100).toFixed(1)}%)`,
                                    metadata: {
                                        payment_method: 'cash',
                                        commission_base: gross,
                                        commission_rate: rate,
                                        commission_amount: commission,
                                        from_balance: fromBalance,
                                        to_debt: toDebt,
                                        merchant_earning: earning,
                                    },
                                },
                            ],
                            result: {
                                balance: newBalance,
                                cash_debt: newDebt,
                                to_debt: toDebt,
                                debt_paid: 0,
                            },
                        };
                    }

                    // ── GATEWAY: uang ada di platform. Kredit bersih ke saldo,
                    // lunasi utang cash lebih dulu.
                    const debtPaid = Math.min(debt, earning);
                    const newDebt = debt - debtPaid;
                    const newBalance = balance + earning - debtPaid;

                    const ledger: LedgerDraft[] = [
                        {
                            entry_type: 'earning_gateway',
                            amount: earning,
                            direction: 'in',
                            balance_after: newBalance + debtPaid, // sebelum pelunasan
                            cash_debt_after: debt,
                            description: `Pendapatan order #${orderId} (net setelah komisi)`,
                            metadata: {
                                payment_method: order.payment_method,
                                commission_base: gross,
                                commission_rate: rate,
                                commission_amount: commission,
                                net_earning: earning,
                            },
                        },
                    ];
                    if (debtPaid > 0) {
                        ledger.push({
                            entry_type: 'debt_payment',
                            amount: debtPaid,
                            direction: 'out',
                            balance_after: newBalance,
                            cash_debt_after: newDebt,
                            description: 'Pelunasan utang komisi cash',
                            metadata: { debt_paid: debtPaid, source: 'order', order_id: orderId },
                        });
                    }

                    return {
                        patch: {
                            balance: newBalance,
                            cash_debt: newDebt,
                            total_earning: Number(w.total_earning) + earning,
                            total_commission_paid: Number(w.total_commission_paid) + commission,
                            total_commission_owed: newDebt,
                        },
                        ledger,
                        result: {
                            balance: newBalance,
                            cash_debt: newDebt,
                            to_debt: 0,
                            debt_paid: debtPaid,
                        },
                    };
                });
            } catch (err: any) {
                // Wallet belum berubah -> lepas klaim supaya bisa diulang
                await supabaseAdmin
                    .from('orders')
                    .update({ merchant_settled_at: null })
                    .eq('id', orderId);
                logger.error('[merchantSettle] gagal, klaim dilepas', {
                    orderId,
                    error: err?.message ?? err,
                });
                return null;
            }

            // Snapshot ke order (best-effort; wallet sudah benar)
            const { error: oErr } = await supabaseAdmin
                .from('orders')
                .update({
                    merchant_commission_rate: rate,
                    merchant_commission_amount: commission,
                    merchant_earning: earning,
                })
                .eq('id', orderId);
            if (oErr) logger.error('[merchantSettle] update order gagal', { orderId, error: oErr });

            if (result.to_debt > 0) {
                try {
                    await notificationService.sendToUser(merchantUserId, {
                        title: 'Komisi Dicatat sebagai Utang',
                        body:
                            `Komisi order #${orderId} ${rp(commission)} dicatat. ` +
                            `Utang komisi toko sekarang ${rp(result.cash_debt)}. ` +
                            `Top up saldo untuk melunasi.`,
                        data: {
                            type: 'merchant_commission_debt',
                            order_id: orderId,
                            cash_debt: result.cash_debt,
                            debt_limit: MERCHANT_DEBT_LIMIT,
                        },
                    });
                } catch (e: any) {
                    logger.warn('[merchantSettle] gagal kirim notif', { error: e?.message });
                }
            }

            logger.info('[merchantSettle] OK', {
                orderId,
                merchantUserId,
                isCash,
                gross,
                rate,
                commission,
                earning,
                ...result,
            });

            return { order_id: orderId, commission_amount: commission, merchant_earning: earning, ...result };
        } catch (err: any) {
            logger.error('[merchantSettle] error', { orderId, error: err?.message ?? err });
            return null;
        }
    }

    // ============================================================
    // TOPUP — dipanggil dari wallet.callback (sukses)
    // Utang dilunasi lebih dulu, sisanya masuk saldo.
    // ============================================================
    async creditTopup(
        userId: string,
        netAmount: number,
        info: {
            partnerReff: string;
            method?: string;
            nominal: number;
            adminFee: number;
            totalBayar: number;
            vaCode?: string;
            serialnumber?: string;
        }
    ) {
        return this.mutate(userId, null, (w) => {
            const balance = Number(w.balance);
            const debt = Number(w.cash_debt);
            const debtPaid = Math.min(debt, netAmount);
            const newDebt = debt - debtPaid;
            const newBalance = balance + netAmount - debtPaid;

            const ledger: LedgerDraft[] = [
                {
                    entry_type: 'topup',
                    amount: netAmount,
                    direction: 'in',
                    balance_after: newBalance + debtPaid, // sebelum pelunasan
                    cash_debt_after: debt,
                    description: `Topup via ${info.method?.toUpperCase() ?? 'LinkQu'} (nominal ${rp(info.nominal)} + fee ${rp(info.adminFee)})`,
                    metadata: {
                        partner_reff: info.partnerReff,
                        va_code: info.vaCode,
                        serialnumber: info.serialnumber,
                        total_bayar: info.totalBayar,
                        nominal: info.nominal,
                        admin_fee: info.adminFee,
                        net_amount: netAmount,
                        debt_paid: debtPaid,
                    },
                },
            ];
            if (debtPaid > 0) {
                ledger.push({
                    entry_type: 'debt_payment',
                    amount: debtPaid,
                    direction: 'out',
                    balance_after: newBalance,
                    cash_debt_after: newDebt,
                    description: 'Pelunasan utang komisi dari topup',
                    metadata: { debt_paid: debtPaid, source: 'topup', partner_reff: info.partnerReff },
                });
            }

            return {
                patch: {
                    balance: newBalance,
                    cash_debt: newDebt,
                    total_commission_paid: Number(w.total_commission_paid) + debtPaid,
                    total_commission_owed: newDebt,
                },
                ledger,
                result: { newBalance, newCashDebt: newDebt, debtPaid },
            };
        });
    }

    // ============================================================
    // WITHDRAW — potong saldo (nominal + fee)
    // ============================================================
    async debitWithdraw(
        userId: string,
        info: {
            nominal: number;
            feeAdmin: number;
            totalDeduction: number;
            bankCode: string;
            accountNumber: string;
            partnerReff: string;
        }
    ) {
        return this.mutate(userId, null, (w) => {
            const newBalance = Number(w.balance) - info.totalDeduction;
            const debt = Number(w.cash_debt);
            return {
                patch: { balance: newBalance },
                ledger: [
                    {
                        entry_type: 'withdraw',
                        amount: info.totalDeduction,
                        direction: 'out',
                        balance_after: newBalance,
                        cash_debt_after: debt,
                        description: `Withdraw ${rp(info.nominal)} ke ${info.bankCode} ${info.accountNumber} + fee ${rp(info.feeAdmin)}`,
                        metadata: {
                            partner_reff: info.partnerReff,
                            nominal: info.nominal,
                            fee_admin: info.feeAdmin,
                            total_deduction: info.totalDeduction,
                        },
                    },
                ],
                result: { newBalance },
            };
        });
    }

    // ============================================================
    // WITHDRAW GAGAL — refund total
    // ============================================================
    async refundWithdraw(
        userId: string,
        info: { inquiryReff: string; nominal: number; feeAdmin: number; totalRefund: number }
    ) {
        return this.mutate(userId, null, (w) => {
            const newBalance = Number(w.balance) + info.totalRefund;
            const debt = Number(w.cash_debt);
            return {
                patch: { balance: newBalance },
                ledger: [
                    {
                        entry_type: 'adjustment',
                        amount: info.totalRefund,
                        direction: 'in',
                        balance_after: newBalance,
                        cash_debt_after: debt,
                        description: `Refund withdraw gagal #${info.inquiryReff} (nominal ${rp(info.nominal)} + fee ${rp(info.feeAdmin)})`,
                        metadata: {
                            inquiry_reff: info.inquiryReff,
                            nominal: info.nominal,
                            fee_admin: info.feeAdmin,
                            total_refund: info.totalRefund,
                        },
                    },
                ],
                result: { newBalance },
            };
        });
    }

    // ============================================================
    // LEDGER — bentuk disesuaikan dengan adapter pendapatan.tsx
    // (type, status, amount bertanda, description, created_at)
    // ============================================================
    async listLedger(userId: string, limit = 50, offset = 0) {
        const { data, error } = await supabaseAdmin
            .from('merchant_wallet_ledger')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw ApiError.internal('Gagal ambil ledger');

        return (data ?? []).map((r: any) => ({
            id: r.id,
            type: r.entry_type,
            status: 'success',
            amount: r.direction === 'in' ? Number(r.amount) : -Number(r.amount),
            description: r.description,
            order_id: r.order_id,
            balance_after: Number(r.balance_after),
            cash_debt_after: Number(r.cash_debt_after),
            created_at: r.created_at,
        }));
    }
}

export const merchantWalletService = new MerchantWalletService();