// src/modules/wallet/wallet.service.ts
import axios from 'axios';
import crypto from 'crypto';
import { supabaseAdmin } from '../../config/supabase';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../config/logger';
import { notificationService } from '../notification/notification.service';  // ✅ TAMBAH
import { merchantWalletService } from './merchant-wallet.service';

// ============================================================
// KONFIGURASI LINKQU
// ============================================================
const LINKQU_CONFIG = {
    clientId: process.env.LINKQU_CLIENT_ID ?? '5f5aa496-7e16-4ca1-9967-33c768dac6c7',
    clientSecret: process.env.LINKQU_CLIENT_SECRET ?? 'TM1rVhfaFm5YJxKruHo0nWMWC',
    username: process.env.LINKQU_USERNAME ?? 'LI9019VKS',
    pin: process.env.LINKQU_PIN ?? '5m6uYAScSxQtCmU',
    serverKey: process.env.LINKQU_SERVER_KEY ?? 'QtwGEr997XDcmMb1Pq8S5X1N',
    baseUrl: process.env.LINKQU_BASE_URL ?? 'https://api.linkqu.id/linkqu-partner',
};

// ============================================================
// LinkU — callback pembayaran & email default (bisa dioverride via env)
// ============================================================
const LINKQU_CALLBACK_URL =
    process.env.LINKQU_CALLBACK_URL ?? 'https://linku.siappgo.id/api/wallet/callback';
const DEFAULT_CUSTOMER_EMAIL =
    process.env.DEFAULT_CUSTOMER_EMAIL ?? 'noreply@siappgo.id';

// ============================================================
// KONSTANTA FEE ADMIN
// ============================================================
const FEE_ADMIN_VA = 2500;
const FEE_ADMIN_BCA = 4000;
const FEE_ADMIN_QRIS_PERCENT = 0.008;

export function calculateAdminFee(
    method: string,
    bankCode: string | null,
    amount: number
): number {
    const m = (method ?? '').toLowerCase();
    if (m === 'qris') return Math.round(amount * FEE_ADMIN_QRIS_PERCENT);
    if (bankCode === '014') return FEE_ADMIN_BCA;
    return FEE_ADMIN_VA;
}

const BANK_MAPPING: Record<string, string> = {
    'VA BRI': '002', BRI: '002',
    'VA MANDIRI': '008', MANDIRI: '008',
    'VA BNI': '009', BNI: '009',
    'VA PERMATA': '013', PERMATA: '013',
    'VA BCA': '014', BCA: '014',
    'VA CIMB': '022', CIMB: '022',
};

const E_WALLET_CODES = ['OVO', 'DANA', 'LINKAJA', 'GOPAY', 'SHOPEEPAY'];
const VA_CODES = ['BRIVA', 'BNIVA', 'MANDIRIVA', 'PERMATAVA'];
const EMONEY_MIN_AMOUNT: Record<string, number> = {
    OVO: 20000, DANA: 10000, LINKAJA: 10000, GOPAY: 10000, SHOPEEPAY: 10000,
};

// ============================================================
// TYPE HELPERS
// ============================================================
type OrderRow = {
    id: number;
    type: string;
    status: string;
    driver_id: string | null;
    customer_id: string;
    delivery_fee: number | null;
    driver_earning: number | null;
    total_fare: number | null;
    tariff_code: string | null;
    payment_method: string | null;
    payment_status: string | null;
    settled_at: string | null;
    commission_amount: number | null;
    commission_rate: number | null;
    platform_earning: number | null;
    settlement_type: string | null;
    subtotal: number | null;          // ✅ FOOD
    packaging_fee: number | null;     // ✅ FOOD
    merchant_earning: number | null;  // ✅ FOOD
    actual_item_total: number | null; // ✅ JASTIP
};

type WalletRow = {
    driver_id: string;
    balance: number;
    cash_debt: number;
    total_earning: number;
    total_commission_paid: number;
    total_commission_owed: number;
    last_payout_at: string | null;
    updated_at: string;
};

// Dompet tujuan uang masuk/keluar. Disimpan di wallet_topups & wallet_withdrawals.
export type WalletType = 'customer' | 'driver' | 'merchant';

type DriverLedgerDraft = {
    entry_type: string;
    amount: number;
    direction: 'in' | 'out';
    balance_after: number;
    cash_debt_after: number;
    description: string;
    metadata?: Record<string, any>;
};

export type DriverWallet = {
    balance: number;
    cash_debt: number;
    net_balance: number;
    total_earning: number;
    total_commission_paid: number;
    total_commission_owed: number;
    last_payout_at: string | null;
    updated_at: string;
};

export type CustomerWallet = {
    balance: number;
    pending_balance: number;
    net_balance: number;
    updated_at: string;
};

// ============================================================
// SERVICE
// ============================================================
class WalletService {
    // ============================================================
    // GET WALLET
    // ============================================================
    async getWallet(userId: string, role: 'driver'): Promise<DriverWallet>;
    async getWallet(userId: string, role: 'customer'): Promise<CustomerWallet>;
    async getWallet(
        userId: string,
        role: 'driver' | 'customer' = 'driver'
    ): Promise<DriverWallet | CustomerWallet> {
        if (role === 'driver') {
            await supabaseAdmin
                .from('driver_wallets')
                .upsert(
                    { driver_id: userId },
                    { onConflict: 'driver_id', ignoreDuplicates: true }
                );

            const { data, error } = await supabaseAdmin
                .from('driver_wallets')
                .select('*')
                .eq('driver_id', userId)
                .single();

            if (error || !data) throw ApiError.internal('Gagal ambil wallet');

            const wallet = data as unknown as WalletRow;

            const result: DriverWallet = {
                balance: Number(wallet.balance),
                cash_debt: Number(wallet.cash_debt),
                net_balance: Number(wallet.balance) - Number(wallet.cash_debt),
                total_earning: Number(wallet.total_earning),
                total_commission_paid: Number(wallet.total_commission_paid),
                total_commission_owed: Number(wallet.total_commission_owed),
                last_payout_at: wallet.last_payout_at,
                updated_at: wallet.updated_at,
            };
            return result;
        }

        await supabaseAdmin
            .from('wallets')
            .upsert(
                { user_id: userId },
                { onConflict: 'user_id', ignoreDuplicates: true }
            );

        const { data, error } = await supabaseAdmin
            .from('wallets')
            .select('*')
            .eq('user_id', userId)
            .single();

        if (error || !data) throw ApiError.internal('Gagal ambil wallet');

        const result: CustomerWallet = {
            balance: Number(data.balance),
            pending_balance: Number(data.pending_balance),
            net_balance: Number(data.balance),
            updated_at: data.updated_at,
        };
        return result;
    }

    // ============================================================
    // HELPER — mutasi dompet DRIVER (optimistic lock via updated_at)
    // Baca -> hitung -> update hanya kalau updated_at belum berubah.
    // Kalau berubah (ada transaksi lain di tengah jalan), ulangi.
    // compute() HARUS murni (tidak ada efek samping) karena bisa dijalankan ulang.
    // ============================================================
    private async mutateDriver<T>(
        driverId: string,
        orderId: number | null,
        compute: (w: WalletRow) => {
            patch: Record<string, number>;
            ledger: DriverLedgerDraft[];
            result: T;
        }
    ): Promise<T> {
        for (let attempt = 1; attempt <= 5; attempt++) {
            await supabaseAdmin
                .from('driver_wallets')
                .upsert(
                    { driver_id: driverId },
                    { onConflict: 'driver_id', ignoreDuplicates: true }
                );

            const { data, error } = await supabaseAdmin
                .from('driver_wallets')
                .select('*')
                .eq('driver_id', driverId)
                .single();
            if (error || !data) throw ApiError.internal('Wallet driver tidak ditemukan');

            const w = data as unknown as WalletRow;
            const { patch, ledger, result } = compute(w);

            let q: any = supabaseAdmin
                .from('driver_wallets')
                .update({ ...patch, updated_at: new Date().toISOString() })
                .eq('driver_id', driverId);
            q = w.updated_at == null ? q.is('updated_at', null) : q.eq('updated_at', w.updated_at);

            const { data: updated, error: uErr } = await q.select('driver_id');
            if (uErr) {
                logger.error('Update wallet driver gagal', { error: uErr, driverId });
                throw ApiError.internal('Gagal update wallet driver');
            }
            if (!updated || updated.length === 0) continue; // wallet berubah, ulangi

            if (ledger.length > 0) {
                const { error: lErr } = await supabaseAdmin
                    .from('driver_wallet_ledger')
                    .insert(
                        ledger.map((l) => ({
                            driver_id: driverId,
                            order_id: orderId,
                            metadata: {},
                            ...l,
                        }))
                    );
                if (lErr) {
                    logger.error('Insert ledger driver gagal', { error: lErr, driverId, orderId });
                }
            }
            return result;
        }
        throw ApiError.internal('Wallet driver sedang sibuk, coba lagi');
    }

    // ============================================================
    // HELPER — mutasi dompet CUSTOMER (tabel wallets), optimistic lock
    // ============================================================
    private async mutateCustomer<T>(
        userId: string,
        compute: (balance: number) => {
            newBalance: number;
            tx?: {
                type: string;
                amount: number;
                reference_id: string | null;
                description: string;
            };
            result: T;
        }
    ): Promise<T> {
        for (let attempt = 1; attempt <= 5; attempt++) {
            await supabaseAdmin
                .from('wallets')
                .upsert(
                    { user_id: userId },
                    { onConflict: 'user_id', ignoreDuplicates: true }
                );

            const { data, error } = await supabaseAdmin
                .from('wallets')
                .select('*')
                .eq('user_id', userId)
                .single();
            if (error || !data) throw ApiError.internal('Wallet customer tidak ditemukan');

            const row = data as any;
            const { newBalance, tx, result } = compute(Number(row.balance ?? 0));

            let q: any = supabaseAdmin
                .from('wallets')
                .update({ balance: newBalance, updated_at: new Date().toISOString() })
                .eq('user_id', userId);
            q = row.updated_at == null ? q.is('updated_at', null) : q.eq('updated_at', row.updated_at);

            const { data: updated, error: uErr } = await q.select('user_id');
            if (uErr) {
                logger.error('Update wallet customer gagal', { error: uErr, userId });
                throw ApiError.internal('Gagal update wallet customer');
            }
            if (!updated || updated.length === 0) continue;

            if (tx) {
                const { error: tErr } = await supabaseAdmin
                    .from('wallet_transactions')
                    .insert({ user_id: userId, ...tx, balance_after: newBalance });
                if (tErr) {
                    logger.error('Insert wallet_transactions gagal', { error: tErr, userId });
                }
            }
            return result;
        }
        throw ApiError.internal('Wallet sedang sibuk, coba lagi');
    }

    // Saldo (balance) sesuai jenis dompet
    private async getBalanceByType(walletType: WalletType, userId: string): Promise<number> {
        if (walletType === 'driver') return (await this.getWallet(userId, 'driver')).balance;
        if (walletType === 'merchant') return (await merchantWalletService.getWallet(userId)).balance;
        return (await this.getWallet(userId, 'customer')).balance;
    }

    // ============================================================
    // TOPUP SUKSES — kreditkan ke dompet sesuai topup.wallet_type
    // Dipanggil dari wallet.callback (handleTopupCallback).
    // ============================================================
    async creditTopup(
        topup: any,
        extra?: { va_code?: string; serialnumber?: string }
    ) {
        const walletType: WalletType = (topup.wallet_type as WalletType) ?? 'customer';
        const userId: string = topup.user_id;

        const nominal = Number(topup.nominal ?? topup.amount);
        const adminFee = Number(topup.admin_fee ?? 0);
        const totalBayar = Number(topup.amount);
        const netAmount = nominal; // yang masuk saldo = nominal (fee tidak ikut)

        const methodLabel = topup.method?.toUpperCase() ?? 'LinkQu';
        const description =
            `Topup via ${methodLabel} (nominal Rp${nominal.toLocaleString('id-ID')} ` +
            `+ fee Rp${adminFee.toLocaleString('id-ID')})`;

        // ── MERCHANT ──
        if (walletType === 'merchant') {
            return merchantWalletService.creditTopup(userId, netAmount, {
                partnerReff: topup.partner_reff,
                method: topup.method,
                nominal,
                adminFee,
                totalBayar,
                vaCode: extra?.va_code,
                serialnumber: extra?.serialnumber,
            });
        }

        // ── DRIVER: lunasi utang cash dulu, sisanya ke saldo ──
        if (walletType === 'driver') {
            return this.mutateDriver(userId, null, (w) => {
                const balance = Number(w.balance ?? 0);
                const debt = Number(w.cash_debt ?? 0);
                const debtPaid = Math.min(debt, netAmount);
                const newDebt = debt - debtPaid;
                const newBalance = balance + netAmount - debtPaid;

                const ledger: DriverLedgerDraft[] = [
                    {
                        entry_type: 'topup',
                        amount: netAmount,
                        direction: 'in',
                        balance_after: balance + netAmount, // kredit penuh
                        cash_debt_after: debt,
                        description,
                        metadata: {
                            partner_reff: topup.partner_reff,
                            va_code: extra?.va_code,
                            serialnumber: extra?.serialnumber,
                            total_bayar: totalBayar,
                            nominal,
                            admin_fee: adminFee,
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
                        description: 'Pelunasan utang cash dari topup',
                        metadata: {
                            debt_paid: debtPaid,
                            source: 'topup',
                            partner_reff: topup.partner_reff,
                        },
                    });
                }

                return {
                    patch: {
                        balance: newBalance,
                        cash_debt: newDebt,
                        total_commission_owed: newDebt,
                        total_commission_paid: Number(w.total_commission_paid ?? 0) + debtPaid,
                    },
                    ledger,
                    result: { newBalance, newCashDebt: newDebt, debtPaid },
                };
            });
        }

        // ── CUSTOMER ──
        return this.mutateCustomer(userId, (balance) => {
            const newBalance = balance + netAmount;
            return {
                newBalance,
                tx: {
                    type: 'topup',
                    amount: netAmount,
                    reference_id: topup.partner_reff,
                    description,
                },
                result: { newBalance, newCashDebt: 0, debtPaid: 0 },
            };
        });
    }

    // ============================================================
    // WITHDRAW — potong saldo (nominal + fee) dengan GUARD saldo.
    // Guard ada di dalam compute (di bawah lock), jadi dua execute
    // bersamaan tidak bisa membuat saldo negatif.
    // ============================================================
    private async debitWithdraw(
        walletType: WalletType,
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
        const insufficient = (balance: number) =>
            ApiError.badRequest(
                `Saldo tidak cukup. Butuh Rp${info.totalDeduction.toLocaleString('id-ID')} ` +
                `(nominal Rp${info.nominal.toLocaleString('id-ID')} + fee Rp${info.feeAdmin.toLocaleString('id-ID')}). ` +
                `Saldo: Rp${balance.toLocaleString('id-ID')}`
            );
        const description =
            `Withdraw Rp${info.nominal.toLocaleString('id-ID')} ke ${info.bankCode} ` +
            `${info.accountNumber} + fee Rp${info.feeAdmin.toLocaleString('id-ID')}`;

        if (walletType === 'merchant') {
            // Pre-check di sini; guard di dalam compute ada di merchantWalletService.debitWithdraw
            const mw = await merchantWalletService.getWallet(userId);
            if (mw.balance < info.totalDeduction) throw insufficient(mw.balance);
            return merchantWalletService.debitWithdraw(userId, info);
        }

        if (walletType === 'driver') {
            return this.mutateDriver(userId, null, (w) => {
                const balance = Number(w.balance ?? 0);
                if (balance < info.totalDeduction) throw insufficient(balance);
                const newBalance = balance - info.totalDeduction;
                return {
                    patch: { balance: newBalance },
                    ledger: [
                        {
                            entry_type: 'withdraw',
                            amount: info.totalDeduction,
                            direction: 'out',
                            balance_after: newBalance,
                            cash_debt_after: Number(w.cash_debt ?? 0),
                            description,
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

        return this.mutateCustomer(userId, (balance) => {
            if (balance < info.totalDeduction) throw insufficient(balance);
            const newBalance = balance - info.totalDeduction;
            return {
                newBalance,
                tx: {
                    type: 'withdraw',
                    amount: info.totalDeduction,
                    reference_id: info.partnerReff,
                    description,
                },
                result: { newBalance },
            };
        });
    }

    // ============================================================
    // WITHDRAW GAGAL — kembalikan saldo ke dompet yang SAMA dengan
    // saat dipotong (wd.wallet_type). Aman dipanggil berkali-kali:
    // kolom wallet_withdrawals.refunded_at diklaim secara atomik.
    //
    // Panggil dari handleWithdrawCallback (status FAILED) dan dari
    // withdrawExecute (kalau LinkQu menolak langsung).
    // ============================================================
    async refundWithdrawal(wd: any): Promise<{ refunded: boolean }> {
        const walletType: WalletType = (wd.wallet_type as WalletType) ?? 'customer';
        const userId: string = wd.user_id;
        const nominal = Number(wd.amount);
        const feeAdmin = Number(wd.fee_admin ?? 0);
        const totalRefund = nominal + feeAdmin;

        // Klaim atomik — hanya satu proses yang boleh refund
        const { data: claimed, error: cErr } = await supabaseAdmin
            .from('wallet_withdrawals')
            .update({ refunded_at: new Date().toISOString() })
            .eq('id', wd.id)
            .is('refunded_at', null)
            .select('id');
        if (cErr) throw ApiError.internal(`Klaim refund gagal: ${cErr.message}`);
        if (!claimed || claimed.length === 0) {
            logger.info('ℹ️ Withdraw sudah direfund, skip', { inquiry_reff: wd.inquiry_reff });
            return { refunded: false };
        }

        const description =
            `Refund withdraw gagal #${wd.inquiry_reff} ` +
            `(nominal Rp${nominal.toLocaleString('id-ID')} + fee Rp${feeAdmin.toLocaleString('id-ID')})`;

        try {
            if (walletType === 'merchant') {
                await merchantWalletService.refundWithdraw(userId, {
                    inquiryReff: wd.inquiry_reff,
                    nominal,
                    feeAdmin,
                    totalRefund,
                });
            } else if (walletType === 'driver') {
                await this.mutateDriver(userId, null, (w) => {
                    const newBalance = Number(w.balance ?? 0) + totalRefund;
                    return {
                        patch: { balance: newBalance },
                        ledger: [
                            {
                                entry_type: 'adjustment',
                                amount: totalRefund,
                                direction: 'in',
                                balance_after: newBalance,
                                cash_debt_after: Number(w.cash_debt ?? 0),
                                description,
                                metadata: {
                                    inquiry_reff: wd.inquiry_reff,
                                    nominal,
                                    fee_admin: feeAdmin,
                                    total_refund: totalRefund,
                                },
                            },
                        ],
                        result: { newBalance },
                    };
                });
            } else {
                await this.mutateCustomer(userId, (balance) => {
                    const newBalance = balance + totalRefund;
                    return {
                        newBalance,
                        tx: {
                            type: 'refund',
                            amount: totalRefund,
                            reference_id: wd.inquiry_reff,
                            description,
                        },
                        result: { newBalance },
                    };
                });
            }
        } catch (err: any) {
            // Saldo belum kembali -> lepas klaim supaya callback berikutnya bisa mencoba lagi
            await supabaseAdmin
                .from('wallet_withdrawals')
                .update({ refunded_at: null })
                .eq('id', wd.id);
            logger.error('Refund withdraw gagal, klaim dilepas', {
                inquiry_reff: wd.inquiry_reff,
                error: err?.message ?? err,
            });
            throw err;
        }

        logger.info('✅ Withdraw direfund', {
            inquiry_reff: wd.inquiry_reff,
            walletType,
            userId,
            totalRefund,
        });
        return { refunded: true };
    }

    // ============================================================
    // SETTLE ORDER — FINAL v2
    //
    // Perbaikan dari versi sebelumnya:
    //  1. Klaim ATOMIK (settled_at diisi lebih dulu dengan kondisi
    //     `settled_at IS NULL`). Dua panggilan bersamaan tidak lagi
    //     membayar driver dua kali.
    //  2. Update wallet pakai optimistic lock (mutateDriver), jadi tidak
    //     menimpa topup/withdraw yang masuk di waktu yang sama.
    //  3. Kalau update wallet gagal, klaim dilepas -> bisa diulang
    //     (dulu: wallet bisa sudah berubah tapi order belum ditandai).
    //  4. Ledger 'debt_payment dari saldo' memakai balance_after yang benar
    //     (sebelumnya newBalance + balanceCredit, seharusnya dikurangi).
    //  5. total_commission_paid ikut bertambah saat utang cash dilunasi
    //     dari order gateway (sebelumnya hanya komisi order itu sendiri).
    //  6. Order CASH: komisi dipotong dari SALDO dulu, sisanya baru jadi utang.
    //  7. Komisi toko (food) ikut diproses lewat merchantWalletService
    //     (idempotent, tidak pernah throw).
    // ============================================================
    async settleOrder(orderId: number) {
        // ────────────────────────────────────────────────────────
        // 1. Ambil order
        // ────────────────────────────────────────────────────────
        const { data: orderRaw, error: oErr } = await supabaseAdmin
            .from('orders')
            .select(`
            id, type, status, driver_id, customer_id,
            delivery_fee, driver_earning, total_fare,
            subtotal, packaging_fee, merchant_earning, actual_item_total,
            tariff_code, payment_method, payment_status,
            settled_at, commission_amount, commission_rate,
            platform_earning, settlement_type
        `)
            .eq('id', orderId)
            .single();

        if (oErr || !orderRaw) throw ApiError.notFound('Order tidak ditemukan');

        const order = orderRaw as unknown as OrderRow;

        // ────────────────────────────────────────────────────────
        // 2. Validasi
        // ────────────────────────────────────────────────────────
        if (order.status !== 'completed') {
            throw ApiError.badRequest('Order belum completed');
        }
        if (!order.driver_id) {
            throw ApiError.badRequest('Order tidak punya driver');
        }
        if (order.settled_at) {
            logger.info('Order sudah di-settle, skip', { orderId });
            return { already_settled: true };
        }

        // ────────────────────────────────────────────────────────
        // 3. Hitung komisi & earning
        //    food / jastip: dasar komisi = delivery_fee (ongkir saja)
        //    ride / send  : total_fare
        // ────────────────────────────────────────────────────────
        const driverId = order.driver_id;
        const isFood = order.type === 'food';
        const isJastip = order.type === 'jastip';

        const commissionRate = await this.getCommissionRate(order.type, order.tariff_code);

        const commissionBase = isFood || isJastip
            ? Number(order.delivery_fee) || 0
            : Number(order.total_fare) || 0;
        const commissionAmount = Math.round(commissionBase * commissionRate);
        const driverEarning = commissionBase - commissionAmount;

        const isCash = order.payment_method === 'cash';
        const settlementType = isCash ? 'cash' : 'gateway';

        const foodMeta = isFood
            ? {
                order_type: 'food',
                delivery_fee: Number(order.delivery_fee) || 0,
                subtotal: Number(order.subtotal) || 0,
                packaging_fee: Number(order.packaging_fee) || 0,
                merchant_earning: Number(order.merchant_earning) || 0,
            }
            : { order_type: order.type };

        // ────────────────────────────────────────────────────────
        // 4. KLAIM ATOMIK — hanya satu proses yang boleh lanjut
        // ────────────────────────────────────────────────────────
        const { data: claimed, error: claimErr } = await supabaseAdmin
            .from('orders')
            .update({
                settled_at: new Date().toISOString(),
                settlement_type: settlementType,
                commission_rate: commissionRate,
                commission_amount: commissionAmount,
                platform_earning: commissionAmount,
                driver_earning: driverEarning,
            })
            .eq('id', order.id)
            .eq('status', 'completed')
            .is('settled_at', null)
            .select('id');

        if (claimErr) {
            logger.error('Klaim settlement gagal', { error: claimErr, orderId });
            throw ApiError.internal('Gagal klaim settlement');
        }
        if (!claimed || claimed.length === 0) {
            logger.info('Order sudah di-settle proses lain, skip', { orderId });
            return { already_settled: true };
        }

        // ────────────────────────────────────────────────────────
        // 5. Update wallet driver (optimistic lock). compute() murni.
        // ────────────────────────────────────────────────────────
        let result: {
            newBalance: number;
            newCashDebt: number;
            jastipReimbursement: number;
            totalDebtPaid: number;
        };

        try {
            result = await this.mutateDriver(driverId, order.id, (w) => {
                let newBalance = Number(w.balance);
                let newCashDebt = Number(w.cash_debt);
                const ledger: DriverLedgerDraft[] = [];
                let totalDebtPaid = 0;

                let cashFromBalance = 0;
                let cashToDebt = 0;

                if (isCash) {
                    // ── CASH: uang order sudah di tangan driver. Komisi ditagih:
                    //    potong SALDO dulu, kekurangannya baru jadi UTANG.
                    const debtBefore = newCashDebt;
                    cashFromBalance = Math.min(Math.max(newBalance, 0), commissionAmount);
                    cashToDebt = commissionAmount - cashFromBalance;
                    newBalance -= cashFromBalance;
                    newCashDebt += cashToDebt;

                    ledger.push({
                        entry_type: 'earning_cash',
                        amount: driverEarning,
                        direction: 'in',
                        balance_after: Number(w.balance),
                        cash_debt_after: debtBefore,
                        description: `Pendapatan cash order #${order.id}`,
                        metadata: {
                            payment_method: 'cash',
                            commission_base: commissionBase,
                            driver_earning: driverEarning,
                            ...foodMeta,
                        },
                    });
                    ledger.push({
                        entry_type: 'commission_cash',
                        amount: commissionAmount,
                        direction: 'out',
                        balance_after: newBalance,
                        cash_debt_after: newCashDebt,
                        description: `Komisi cash order #${order.id} (${(commissionRate * 100).toFixed(1)}%)`,
                        metadata: {
                            commission_rate: commissionRate,
                            commission_base: commissionBase,
                            commission_amount: commissionAmount,
                            from_balance: cashFromBalance,
                            to_debt: cashToDebt,
                            ...foodMeta,
                        },
                    });
                } else {
                    // ── GATEWAY: lunasi utang cash dari SALDO AKTIF dulu,
                    //    lalu dari EARNING order ini, sisanya masuk saldo.
                    const netEarning = driverEarning;
                    let debtPaidFromBalance = 0;
                    let debtPaidFromEarning = 0;

                    if (newCashDebt > 0) {
                        if (newBalance > 0) {
                            debtPaidFromBalance = Math.min(newCashDebt, newBalance);
                            newBalance -= debtPaidFromBalance;
                            newCashDebt -= debtPaidFromBalance;
                        }
                        if (newCashDebt > 0) {
                            debtPaidFromEarning = Math.min(newCashDebt, netEarning);
                            newCashDebt -= debtPaidFromEarning;
                        }
                    }

                    const balanceCredit = netEarning - debtPaidFromEarning;
                    newBalance += balanceCredit;
                    totalDebtPaid = debtPaidFromBalance + debtPaidFromEarning;

                    ledger.push({
                        entry_type: 'earning_gateway',
                        amount: netEarning,
                        direction: 'in',
                        balance_after: newBalance,
                        cash_debt_after: newCashDebt,
                        description: `Pendapatan order #${order.id} (net setelah komisi)`,
                        metadata: {
                            payment_method: order.payment_method,
                            commission_base: commissionBase,
                            commission_amount: commissionAmount,
                            net_earning: netEarning,
                            debt_paid_from_balance: debtPaidFromBalance,
                            debt_paid_from_earning: debtPaidFromEarning,
                            ...foodMeta,
                        },
                    });

                    if (debtPaidFromBalance > 0) {
                        ledger.push({
                            entry_type: 'debt_payment',
                            amount: debtPaidFromBalance,
                            direction: 'out',
                            // ✅ FIX: saldo SEBELUM kredit earning = newBalance - balanceCredit
                            balance_after: newBalance - balanceCredit,
                            cash_debt_after: newCashDebt + debtPaidFromEarning,
                            description: 'Pelunasan utang cash dari saldo aktif',
                            metadata: { source: 'balance', debt_paid: debtPaidFromBalance },
                        });
                    }
                    if (debtPaidFromEarning > 0) {
                        ledger.push({
                            entry_type: 'debt_payment',
                            amount: debtPaidFromEarning,
                            direction: 'out',
                            balance_after: newBalance,
                            cash_debt_after: newCashDebt,
                            description: 'Pelunasan utang cash dari pendapatan order',
                            metadata: { source: 'earning', debt_paid: debtPaidFromEarning },
                        });
                    }
                }

                // ── JASTIP (non-cash): ganti uang talangan belanja driver.
                //    Bukan pendapatan: tanpa komisi, tidak ikut total_earning,
                //    tidak dipakai melunasi utang cash.
                let jastipReimbursement = 0;
                if (isJastip && !isCash) {
                    jastipReimbursement = Math.round(Number(order.actual_item_total) || 0);
                    if (jastipReimbursement > 0) {
                        newBalance += jastipReimbursement;
                        ledger.push({
                            entry_type: 'jastip_reimbursement',
                            amount: jastipReimbursement,
                            direction: 'in',
                            balance_after: newBalance,
                            cash_debt_after: newCashDebt,
                            description: `Ganti uang belanja jastip order #${order.id}`,
                            metadata: {
                                order_type: 'jastip',
                                actual_item_total: jastipReimbursement,
                            },
                        });
                    }
                }

                return {
                    patch: {
                        balance: newBalance,
                        cash_debt: newCashDebt,
                        total_earning: Number(w.total_earning) + driverEarning,
                        // ✅ komisi order ini (gateway) + utang lama yang lunas sekarang
                        total_commission_paid:
                            Number(w.total_commission_paid) +
                            (isCash ? cashFromBalance : commissionAmount) +
                            totalDebtPaid,
                        total_commission_owed: newCashDebt,
                    },
                    ledger,
                    result: { newBalance, newCashDebt, jastipReimbursement, totalDebtPaid },
                };
            });
        } catch (err: any) {
            // Wallet belum berubah -> lepas klaim supaya settlement bisa diulang
            await supabaseAdmin
                .from('orders')
                .update({ settled_at: null, settlement_type: null })
                .eq('id', order.id);
            logger.error('Settle gagal, klaim dilepas', {
                orderId,
                error: err?.message ?? err,
            });
            throw err;
        }

        // ────────────────────────────────────────────────────────
        // 6. Order cash -> payment_status 'paid' (best-effort)
        // ────────────────────────────────────────────────────────
        if (isCash) {
            const { error: pErr } = await supabaseAdmin
                .from('orders')
                .update({ payment_status: 'paid' })
                .eq('id', order.id);
            if (pErr) logger.error('Update payment_status gagal', { orderId, error: pErr });
        }

        if (result.totalDebtPaid > 0) {
            logger.info('Auto-lunasi utang cash saat order gateway', {
                orderId: order.id,
                driverId,
                totalDebtPaid: result.totalDebtPaid,
                remainingDebt: result.newCashDebt,
            });
        }

        // ────────────────────────────────────────────────────────
        // 7. Komisi toko untuk order FOOD (idempotent, tidak pernah throw)
        // ────────────────────────────────────────────────────────
        if (isFood) {
            await merchantWalletService.settleOrder(order.id);
        }

        logger.info('Order settled', {
            orderId: order.id,
            orderType: order.type,
            driverId,
            settlementType,
            commissionBase,
            commissionRate,
            commissionAmount,
            driverEarning,
            newBalance: result.newBalance,
            newCashDebt: result.newCashDebt,
        });

        return {
            order_id: order.id,
            settlement_type: settlementType,
            commission_rate: commissionRate,
            commission_amount: commissionAmount,
            driver_earning: driverEarning,
            new_balance: result.newBalance,
            new_cash_debt: result.newCashDebt,
            jastip_reimbursement: result.jastipReimbursement,
        };
    }
    // ============================================================
    // GET COMMISSION RATE — FINAL (Fixed)
    // ============================================================
    async getCommissionRate(
        orderType: string,
        tariffCode?: string | null
    ): Promise<number> {
        const { data, error } = await supabaseAdmin.rpc('get_commission_rate', {
            p_order_type: orderType,
            p_tariff_code: tariffCode ?? null,
        });

        if (error || data == null) {
            logger.warn('Gagal ambil commission rate, pakai default', {
                error,
                orderType,
                tariffCode,
            });
            // Fallback: sesuaikan dengan function DB
            if (orderType === 'food') return 0.15;
            if (orderType === 'send' || orderType === 'jastip') return 0.10;
            return 0.08;                    // ⬅️ FIX: ride default 8%
        }

        return Number(data);
    }

    // ============================================================
    // REQUEST PAYOUT (driver only)
    // Saldo dipotong di bawah lock + guard, jadi request ganda
    // tidak bisa membuat saldo negatif.
    // ============================================================
    async requestPayout(
        driverId: string,
        amount: number,
        bankInfo: { bank_code: string; bank_name: string; account_number: string; account_name: string; }
    ) {
        if (amount <= 0) throw ApiError.badRequest('Jumlah harus > 0');

        const MIN_PAYOUT = 50000;
        if (amount < MIN_PAYOUT) {
            throw ApiError.badRequest(`Minimal pencairan Rp${MIN_PAYOUT.toLocaleString('id-ID')}`);
        }

        const { data: payoutRaw, error: pErr } = await supabaseAdmin
            .from('payouts')
            .insert({ driver_id: driverId, amount, status: 'pending', ...bankInfo })
            .select()
            .single();

        if (pErr || !payoutRaw) throw ApiError.internal('Gagal buat payout');

        const payout = payoutRaw as any;

        try {
            await this.mutateDriver(driverId, null, (w) => {
                const balance = Number(w.balance);
                const debt = Number(w.cash_debt);

                if (balance < amount) {
                    throw ApiError.badRequest(
                        `Saldo tidak cukup. Saldo tersedia: Rp${balance.toLocaleString('id-ID')}`
                    );
                }
                if (debt > 0) {
                    throw ApiError.badRequest(
                        `Lunasi utang cash dulu (Rp${debt.toLocaleString('id-ID')})`
                    );
                }

                const newBalance = balance - amount;
                return {
                    patch: { balance: newBalance },
                    ledger: [
                        {
                            entry_type: 'payout',
                            amount,
                            direction: 'out',
                            balance_after: newBalance,
                            cash_debt_after: debt,
                            description: `Request payout #${payout.id}`,
                            metadata: { payout_id: payout.id, ...bankInfo },
                        },
                    ],
                    result: { newBalance },
                };
            });
        } catch (err) {
            // Saldo tidak terpotong -> batalkan baris payout
            await supabaseAdmin.from('payouts').delete().eq('id', payout.id);
            throw err;
        }

        logger.info('Payout requested', { payoutId: payout.id, driverId, amount });

        return payout;
    }

    // ============================================================
    // LIST LEDGER (driver)
    // ============================================================
    async listLedger(driverId: string, limit = 50, offset = 0) {
        const { data, error } = await supabaseAdmin
            .from('driver_wallet_ledger')
            .select('*')
            .eq('driver_id', driverId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw ApiError.internal('Gagal ambil ledger');
        return data ?? [];
    }

    // ============================================================
    // LIST LEDGER (customer)
    // ============================================================
    async listLedgerCustomer(userId: string, limit = 50, offset = 0) {
        const { data, error } = await supabaseAdmin
            .from('wallet_transactions')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw ApiError.internal('Gagal ambil ledger');
        return data ?? [];
    }

    // ============================================================
    // LIST PAYOUTS (driver)
    // ============================================================
    async listPayouts(driverId: string, limit = 20) {
        const { data, error } = await supabaseAdmin
            .from('payouts')
            .select('*')
            .eq('driver_id', driverId)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) throw ApiError.internal('Gagal ambil payout');
        return data ?? [];
    }

    async topupInquiry(userId: string, dto: {
        amount: number;
        method: 'va' | 'qris';
        bank_code?: string;
        walletType?: WalletType;   // ✅ dompet tujuan (dari role akun, bukan body)
    }) {
        console.log('🚀 [topupInquiry] START', { userId, dto });

        if (dto.amount < 100) {
            throw ApiError.badRequest('Minimal topup Rp10.000');
        }

        // ═══════════════════════════════════════════════════════════
        // ✅ HITUNG FEE ADMIN (ditambahkan ke nominal)
        // ═══════════════════════════════════════════════════════════
        const adminFee = calculateAdminFee(
            dto.method,
            dto.bank_code ?? null,
            dto.amount
        );
        const totalAmount = dto.amount + adminFee;   // ← yang dibayar user

        console.log('💰 [topupInquiry] Fee & total:', {
            nominal: dto.amount,
            adminFee,
            totalAmount,
        });

        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('full_name, email')
            .eq('id', userId)
            .single();

        const customerName = profile?.full_name ?? 'Customer';
        const customerEmail = profile?.email ?? DEFAULT_CUSTOMER_EMAIL;

        const partnerReff = `TOPUP-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        const expired = this.generateExpiredTimestamp();

        let endpoint = '';
        let payload: any = {};

        if (dto.method === 'qris') {
            endpoint = '/transaction/create/qris';
            const signature = this.signQris({
                amount: totalAmount,          // ✅ pakai totalAmount
                expired,
                partner_reff: partnerReff,
                customer_id: userId,
                customer_name: customerName,
                customer_email: customerEmail,
            });
            payload = {
                username: LINKQU_CONFIG.username,
                pin: LINKQU_CONFIG.pin,
                amount: totalAmount,          // ✅ pakai totalAmount
                partner_reff: partnerReff,
                expired,
                signature,
                url_callback: LINKQU_CALLBACK_URL,
                customer_id: userId,
                customer_name: customerName,
                customer_email: customerEmail,
            };
        } else {
            if (!dto.bank_code) throw ApiError.badRequest('bank_code wajib untuk VA');
            endpoint = '/transaction/create/va';
            const realBankCode = BANK_MAPPING[dto.bank_code.toUpperCase()] || dto.bank_code;
            const signature = this.signVa({
                amount: totalAmount,          // ✅ pakai totalAmount
                expired,
                bank_code: realBankCode,
                partner_reff: partnerReff,
                customer_id: userId,
                customer_name: customerName,
                customer_email: customerEmail,
            });
            payload = {
                username: LINKQU_CONFIG.username,
                pin: LINKQU_CONFIG.pin,
                amount: totalAmount,          // ✅ pakai totalAmount
                bank_code: realBankCode,
                partner_reff: partnerReff,
                expired,
                signature,
                url_callback: LINKQU_CALLBACK_URL,
                customer_id: userId,
                customer_name: customerName,
                customer_email: customerEmail,
            };
        }

        const url = `${LINKQU_CONFIG.baseUrl}${endpoint}`;
        console.log('📤 [LINKQU REQUEST]', { url, payload });

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'client-id': LINKQU_CONFIG.clientId,
                    'client-secret': LINKQU_CONFIG.clientSecret,
                    'Content-Type': 'text/plain',
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    Accept: 'application/json, text/plain, */*',
                },
                body: JSON.stringify(payload),
            });

            console.log('📥 [LINKQU HTTP]', response.status);

            const rawText = await response.text();
            console.log('📥 [LINKQU RAW]', rawText);

            if (!response.ok) {
                throw ApiError.internal(
                    `LinkQu error ${response.status}: ${rawText.slice(0, 200)}`
                );
            }

            let data: any;
            try {
                data = JSON.parse(rawText);
            } catch {
                throw ApiError.internal('Response LinkQu tidak valid');
            }

            console.log('✅ [LINKQU PARSED]', JSON.stringify(data, null, 2));

            // ═══════════════════════════════════════════════════════════
            // ✅ SIMPAN KE DB dengan nominal + admin_fee + amount (total)
            // ═══════════════════════════════════════════════════════════
            const { error: dbErr } = await supabaseAdmin
                .from('wallet_topups')
                .insert({
                    user_id: userId,
                    wallet_type: dto.walletType ?? 'customer',   // ✅ dompet tujuan
                    partner_reff: partnerReff,
                    method: dto.method,
                    amount: totalAmount,          // Rp12.500 (total bayar)
                    nominal: dto.amount,          // Rp10.000 (nominal topup)
                    admin_fee: adminFee,          // Rp2.500 (fee)
                    bank_code: dto.bank_code ?? null,
                    va_number: data?.virtual_account ?? null,
                    qris_url: data?.imageqris ?? null,
                    status: 'PENDING',
                    raw_response: data,
                    expired_at: this.parseExpiredToDate(expired),
                });

            if (dbErr) {
                console.error('❌ [DB] Insert wallet_topups gagal:', dbErr);
                logger.error('Insert wallet_topups gagal', { error: dbErr });
            }

            // ═══════════════════════════════════════════════════════════
            // ✅ NOTIFIKASI dengan info lengkap
            // ═══════════════════════════════════════════════════════════
            await notificationService.sendToUser(userId, {
                title: 'Kode Pembayaran Dibuat',
                body:
                    dto.method === 'qris'
                        ? `Scan QRIS Rp${totalAmount.toLocaleString('id-ID')} (nominal Rp${dto.amount.toLocaleString('id-ID')} + fee Rp${adminFee.toLocaleString('id-ID')}). Berlaku sampai ${this.formatExpiredDisplay(expired)}.`
                        : `Transfer VA ${data?.virtual_account ?? '-'} sebesar Rp${totalAmount.toLocaleString('id-ID')} (nominal Rp${dto.amount.toLocaleString('id-ID')} + fee Rp${adminFee.toLocaleString('id-ID')}). Berlaku sampai ${this.formatExpiredDisplay(expired)}.`,
                data: {
                    type: 'topup_created',
                    method: dto.method,
                    amount: dto.amount,           // nominal
                    admin_fee: adminFee,          // fee
                    total_amount: totalAmount,    // total bayar
                    va_number: data?.virtual_account ?? null,
                    qris_url: data?.imageqris ?? null,
                    partner_reff: partnerReff,
                },
            });

            return { ...data, partner_reff: partnerReff };
        } catch (err: any) {
            if (err instanceof ApiError) throw err;

            console.error('💥 [topupInquiry] ERROR:', err);
            logger.error('Topup inquiry error', {
                error: err?.message ?? err,
            });
            throw ApiError.internal('Gagal membuat topup');
        }
    }
    // ============================================================
    // TOPUP — CHECK STATUS ke LinkQu
    // ============================================================
    async topupExecute(userId: string, partnerReff: string) {
        console.log('🔍 [topupExecute] START', { userId, partnerReff });

        const { data: topup } = await supabaseAdmin
            .from('wallet_topups')
            .select('*')
            .eq('partner_reff', partnerReff)
            .eq('user_id', userId)
            .single();

        if (!topup) throw ApiError.notFound('Topup tidak ditemukan');
        if (topup.status === 'SUCCESS') {
            return { status: 'SUCCESS', message: 'Sudah dibayar' };
        }

        const url = new URL(
            `${LINKQU_CONFIG.baseUrl}/transaction/payment/checkstatus`
        );
        url.searchParams.set('username', LINKQU_CONFIG.username);
        url.searchParams.set('partnerreff', partnerReff);

        console.log('📤 [LINKQU REQUEST]', { url: url.toString() });

        try {
            const response = await fetch(url.toString(), {
                method: 'GET',
                headers: {
                    'client-id': LINKQU_CONFIG.clientId,
                    'client-secret': LINKQU_CONFIG.clientSecret,
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    Accept: 'application/json, text/plain, */*',
                    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
                },
            });

            console.log('📥 [LINKQU HTTP]', response.status, response.statusText);

            const rawText = await response.text();
            console.log('📥 [LINKQU RAW]', rawText);

            if (!response.ok) {
                console.error('❌ [LINKQU ERROR]', response.status, rawText.slice(0, 500));
                logger.error('Topup execute HTTP error', {
                    status: response.status,
                    body: rawText.slice(0, 500),
                });
                throw ApiError.internal(
                    `LinkQu error ${response.status}: ${rawText.slice(0, 200)}`
                );
            }

            let data: any;
            try {
                data = JSON.parse(rawText);
            } catch {
                console.error('❌ [LINKQU] Response bukan JSON:', rawText);
                throw ApiError.internal('Response LinkQu tidak valid');
            }

            console.log('✅ [LINKQU PARSED]', JSON.stringify(data, null, 2));

            // const statusFromLinkqu = data?.status;
            // if (
            //     statusFromLinkqu === 'SUCCESS' ||
            //     statusFromLinkqu === 'SETTLED' ||
            //     statusFromLinkqu === 'PAID'
            // ) {
            //     await supabaseAdmin
            //         .from('wallet_topups')
            //         .update({
            //             status: 'SUCCESS',
            //             updated_at: new Date().toISOString(),
            //         })
            //         .eq('partner_reff', partnerReff);
            //     console.log('✅ [DB] Topup ditandai SUCCESS');
            // }

            return data;
        } catch (err: any) {
            if (err instanceof ApiError) throw err;

            console.error('💥 [topupExecute] ERROR:', err);
            logger.error('Topup execute error', {
                error: err?.message ?? err,
            });
            throw ApiError.internal('Gagal cek status topup');
        }
    }

    // ============================================================
    // TOPUP — GET STATUS dari DB
    // ============================================================
    async topupStatus(userId: string, partnerReff: string) {
        const { data } = await supabaseAdmin
            .from('wallet_topups')
            .select('*')
            .eq('partner_reff', partnerReff)
            .eq('user_id', userId)
            .single();
        if (!data) throw ApiError.notFound('Topup tidak ditemukan');
        return data;
    }

    // ============================================================
    // WITHDRAW — INQUIRY
    // Dompet ditentukan controller dari role akun (walletType),
    // lalu DISIMPAN di baris wallet_withdrawals.wallet_type.
    // ============================================================
    async withdrawInquiry(userId: string, dto: {
        amount: number;
        bank_code: string;
        account_number: string;
        walletType: WalletType;
    }) {
        const walletType: WalletType = dto.walletType;
        const balance = await this.getBalanceByType(walletType, userId);

        // ═══════════════════════════════════════════════════════════
        // ✅ HITUNG FEE ADMIN WITHDRAW
        // ═══════════════════════════════════════════════════════════
        const WITHDRAW_FEE = 3000;
        const totalDeduction = dto.amount + WITHDRAW_FEE;

        // Cek saldo terhadap TOTAL (nominal + fee). Dicek ULANG saat execute.
        if (balance < totalDeduction) {
            throw ApiError.badRequest(
                `Saldo tidak cukup. Butuh Rp${totalDeduction.toLocaleString('id-ID')} ` +
                `(nominal Rp${dto.amount.toLocaleString('id-ID')} + fee Rp${WITHDRAW_FEE.toLocaleString('id-ID')}). ` +
                `Saldo: Rp${balance.toLocaleString('id-ID')}`
            );
        }

        const isEmoney = E_WALLET_CODES.includes(dto.bank_code.toUpperCase());
        if (isEmoney) {
            const min = EMONEY_MIN_AMOUNT[dto.bank_code.toUpperCase()] || 10000;
            if (dto.amount < min) {
                throw ApiError.badRequest(
                    `Minimum ${dto.bank_code} Rp${min.toLocaleString('id-ID')}`
                );
            }
        }

        const inquiryReff = `INQ${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        const realBankCode = BANK_MAPPING[dto.bank_code.toUpperCase()] || dto.bank_code;

        let endpoint = '/transaction/withdraw/inquiry';
        let method: 'GET' | 'POST' = 'POST';
        if (isEmoney) {
            endpoint = '/transaction/reload/inquiry';
            method = 'GET';
        } else if (VA_CODES.includes(dto.bank_code.toUpperCase())) {
            endpoint = '/transaction/transferva/inquiry';
            method = 'POST';
        }

        // Signature pakai nominal yang ditransfer (bukan total)
        const sigData = {
            amount: dto.amount,
            accountnumber: dto.account_number,
            bankcode: realBankCode,
            partnerreff: inquiryReff,
        };
        const signature = crypto
            .createHmac('sha256', LINKQU_CONFIG.clientSecret)
            .update(JSON.stringify(sigData))
            .digest('hex');

        const params = {
            username: LINKQU_CONFIG.username,
            pin: LINKQU_CONFIG.pin,
            bankcode: realBankCode,
            accountnumber: dto.account_number,
            amount: dto.amount,
            partner_reff: inquiryReff,
            signature,
        };

        try {
            const response = method === 'GET'
                ? await axios.get(`${LINKQU_CONFIG.baseUrl}${endpoint}`, {
                    params,
                    headers: {
                        'client-id': LINKQU_CONFIG.clientId,
                        'client-secret': LINKQU_CONFIG.clientSecret,
                    },
                })
                : await axios.post(`${LINKQU_CONFIG.baseUrl}${endpoint}`, params, {
                    headers: {
                        'client-id': LINKQU_CONFIG.clientId,
                        'client-secret': LINKQU_CONFIG.clientSecret,
                    },
                });

            const { error: insErr } = await supabaseAdmin.from('wallet_withdrawals').insert({
                user_id: userId,
                wallet_type: walletType,            // ✅ dompet tujuan potongan
                inquiry_reff: response.data.inquiry_reff ?? inquiryReff,
                partner_reff: inquiryReff,
                bank_code: realBankCode,
                account_number: dto.account_number,
                amount: dto.amount,
                fee_admin: WITHDRAW_FEE,
                status: 'INQUIRY',
                raw_response: response.data,
            });
            if (insErr) {
                logger.error('Insert wallet_withdrawals gagal', { error: insErr });
                throw ApiError.internal('Gagal menyimpan inquiry withdraw');
            }

            return {
                ...response.data,
                partner_reff: inquiryReff,
                amount: dto.amount,
                fee_admin: WITHDRAW_FEE,
                total_deduction: totalDeduction,
            };
        } catch (err: any) {
            if (err instanceof ApiError) throw err;
            logger.error('Withdraw inquiry error', {
                error: err.response?.data || err.message,
            });
            throw ApiError.internal('Gagal inquiry withdraw');
        }
    }

    // ============================================================
    // WITHDRAW — EXECUTE
    //
    // Urutan baru (anti saldo negatif / uang keluar tanpa potongan):
    //  1. Klaim atomik baris inquiry: INQUIRY -> PENDING
    //     (execute ganda untuk inquiry yang sama ditolak).
    //  2. POTONG saldo dulu, dengan guard saldo di bawah lock.
    //  3. Baru kirim ke LinkQu.
    //  4. Kalau LinkQu menolak jelas (ada response error) -> refund.
    //     Kalau tidak ada response sama sekali (timeout) -> status
    //     dibiarkan PENDING & saldo tetap terpotong; callback LinkQu /
    //     admin yang memutuskan (hindari refund padahal uang sudah keluar).
    //
    // Dompet diambil dari baris inquiry (wallet_type), bukan dari request.
    // ============================================================
    async withdrawExecute(userId: string, inquiryReff: string) {
        const { data: inq } = await supabaseAdmin
            .from('wallet_withdrawals')
            .select('*')
            .eq('inquiry_reff', inquiryReff)
            .eq('user_id', userId)
            .single();

        if (!inq) throw ApiError.notFound('Inquiry tidak ditemukan');
        if (inq.status !== 'INQUIRY') {
            throw ApiError.badRequest('Inquiry sudah diproses');
        }

        const walletType: WalletType = ((inq as any).wallet_type as WalletType) ?? 'customer';

        const feeAdmin = Number(inq.fee_admin ?? 3000);
        const nominalTransfer = Number(inq.amount);
        const totalDeduction = nominalTransfer + feeAdmin;

        const partnerReffPay = `PAY${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

        // ── 1. Klaim atomik ──
        const { data: claimed, error: claimErr } = await supabaseAdmin
            .from('wallet_withdrawals')
            .update({
                status: 'PENDING',
                partner_reff_pay: partnerReffPay,
                updated_at: new Date().toISOString(),
            })
            .eq('id', inq.id)
            .eq('status', 'INQUIRY')
            .select('id');

        if (claimErr) throw ApiError.internal('Gagal memproses withdraw');
        if (!claimed || claimed.length === 0) {
            throw ApiError.badRequest('Inquiry sudah diproses');
        }

        const releaseClaim = async () => {
            await supabaseAdmin
                .from('wallet_withdrawals')
                .update({
                    status: 'INQUIRY',
                    partner_reff_pay: null,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', inq.id);
        };

        // ── 2. Potong saldo (guard saldo di dalam lock) ──
        try {
            await this.debitWithdraw(walletType, userId, {
                nominal: nominalTransfer,
                feeAdmin,
                totalDeduction,
                bankCode: inq.bank_code,
                accountNumber: inq.account_number,
                partnerReff: partnerReffPay,
            });
        } catch (err) {
            await releaseClaim(); // saldo tidak terpotong -> inquiry bisa dipakai lagi
            throw err;
        }

        // ── 3. Kirim ke LinkQu ──
        const isEmoney = E_WALLET_CODES.includes(inq.bank_code.toUpperCase());
        let endpoint = '/transaction/withdraw/payment';
        let method: 'GET' | 'POST' = 'POST';
        if (isEmoney) {
            endpoint = '/transaction/reload/payment';
            method = 'GET';
        } else if (VA_CODES.includes(inq.bank_code.toUpperCase())) {
            endpoint = '/transaction/transferva/payment';
        }

        const sigData = {
            amount: nominalTransfer,
            accountnumber: inq.account_number,
            bankcode: inq.bank_code,
            partnerreff: partnerReffPay,
            inquiryreff: inquiryReff,
        };
        const signature = crypto
            .createHmac('sha256', LINKQU_CONFIG.clientSecret)
            .update(JSON.stringify(sigData))
            .digest('hex');

        const payload = {
            username: LINKQU_CONFIG.username,
            pin: LINKQU_CONFIG.pin,
            bankcode: inq.bank_code,
            accountnumber: inq.account_number,
            amount: nominalTransfer,
            partner_reff: partnerReffPay,
            inquiry_reff: inquiryReff,
            signature,
            remark: 'Withdraw Mitra',
            url_callback: LINKQU_CALLBACK_URL,
        };

        let responseData: any;
        try {
            const response =
                method === 'GET'
                    ? await axios.get(`${LINKQU_CONFIG.baseUrl}${endpoint}`, {
                        params: payload,
                        headers: {
                            'client-id': LINKQU_CONFIG.clientId,
                            'client-secret': LINKQU_CONFIG.clientSecret,
                        },
                    })
                    : await axios.post(`${LINKQU_CONFIG.baseUrl}${endpoint}`, payload, {
                        headers: {
                            'client-id': LINKQU_CONFIG.clientId,
                            'client-secret': LINKQU_CONFIG.clientSecret,
                        },
                    });
            responseData = response.data;
        } catch (err: any) {
            logger.error('Withdraw execute error', {
                error: err.response?.data || err.message,
            });

            if (err.response) {
                // ── LinkQu menolak dengan jelas -> uang belum keluar -> refund ──
                await supabaseAdmin
                    .from('wallet_withdrawals')
                    .update({
                        status: 'FAILED',
                        raw_payment_response: err.response.data ?? null,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('id', inq.id);

                try {
                    await this.refundWithdrawal({ ...inq, wallet_type: walletType });
                } catch (refundErr: any) {
                    logger.error('🚨 Refund withdraw GAGAL setelah LinkQu menolak — perlu cek manual', {
                        inquiry_reff: inquiryReff,
                        userId,
                        walletType,
                        totalDeduction,
                        error: refundErr?.message ?? refundErr,
                    });
                }
                throw ApiError.internal('Gagal memproses withdraw');
            }

            // ── Tidak ada response (timeout/jaringan): status tidak pasti ──
            logger.error('🚨 Withdraw status tidak pasti (tanpa response) — dibiarkan PENDING', {
                inquiry_reff: inquiryReff,
                userId,
                walletType,
                totalDeduction,
            });
            return {
                internal_status: 'PENDING',
                partner_reff: partnerReffPay,
                amount: nominalTransfer,
                fee_admin: feeAdmin,
                total_deduction: totalDeduction,
            };
        }

        // ── 4. Simpan hasil ──
        const finalStatus = responseData.status === 'SUCCESS' ? 'SUCCESS' : 'PENDING';
        const notifiedAtNow = finalStatus === 'SUCCESS' ? new Date().toISOString() : null;

        await supabaseAdmin
            .from('wallet_withdrawals')
            .update({
                status: finalStatus,
                partner_reff_pay: partnerReffPay,
                notified_at: notifiedAtNow,
                raw_payment_response: responseData,
                updated_at: new Date().toISOString(),
            })
            .eq('id', inq.id);

        // ── 5. Notifikasi (gagal kirim tidak boleh membatalkan withdraw) ──
        try {
            if (finalStatus === 'SUCCESS') {
                await notificationService.sendToUser(userId, {
                    title: 'Penarikan Berhasil',
                    body:
                        `Penarikan Rp${nominalTransfer.toLocaleString('id-ID')} ` +
                        `ke ${inq.bank_code} ${inq.account_number} berhasil. ` +
                        `Fee admin Rp${feeAdmin.toLocaleString('id-ID')}. ` +
                        `Total dipotong Rp${totalDeduction.toLocaleString('id-ID')}.`,
                    data: {
                        type: 'withdraw_success',
                        amount: nominalTransfer,
                        fee_admin: feeAdmin,
                        total_deduction: totalDeduction,
                        inquiry_reff: inquiryReff,
                        partner_reff: partnerReffPay,
                    },
                });
            } else {
                await notificationService.sendToUser(userId, {
                    title: 'Penarikan Diproses',
                    body:
                        `Penarikan Rp${nominalTransfer.toLocaleString('id-ID')} ` +
                        `ke ${inq.bank_code} ${inq.account_number} sedang diproses. ` +
                        `Fee admin Rp${feeAdmin.toLocaleString('id-ID')}.`,
                    data: {
                        type: 'withdraw_pending',
                        amount: nominalTransfer,
                        fee_admin: feeAdmin,
                        total_deduction: totalDeduction,
                        inquiry_reff: inquiryReff,
                        partner_reff: partnerReffPay,
                    },
                });
            }
        } catch (err: any) {
            logger.warn('Gagal kirim notif withdraw (execute)', {
                inquiry_reff: inquiryReff,
                error: err.message,
            });
        }

        return {
            ...responseData,
            internal_status: finalStatus,
            partner_reff: partnerReffPay,
            amount: nominalTransfer,
            fee_admin: feeAdmin,
            total_deduction: totalDeduction,
        };
    }

    // ============================================================
    // LIST TOPUPS — history topup user
    // ============================================================
    async listTopups(
        userId: string,
        limit = 20,
        offset = 0,
        status?: string
    ) {
        let query = supabaseAdmin
            .from('wallet_topups')
            .select('*', { count: 'exact' })
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (status) {
            query = query.eq('status', status);
        }

        const { data, error, count } = await query;

        if (error) {
            logger.error('Gagal ambil list topups', {
                error: error.message,
                userId,
            });
            throw ApiError.internal('Gagal ambil history topup');
        }

        return {
            items: data ?? [],
            total: count ?? 0,
            limit,
            offset,
        };
    }

    // ============================================================
    // LIST WITHDRAWALS — history withdraw user
    // ============================================================
    async listWithdrawals(
        userId: string,
        limit = 20,
        offset = 0,
        status?: string
    ) {
        let query = supabaseAdmin
            .from('wallet_withdrawals')
            .select('*', { count: 'exact' })
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (status) {
            query = query.eq('status', status);
        }

        const { data, error, count } = await query;

        if (error) {
            logger.error('Gagal ambil list withdrawals', {
                error: error.message,
                userId,
            });
            throw ApiError.internal('Gagal ambil history withdraw');
        }

        return {
            items: data ?? [],
            total: count ?? 0,
            limit,
            offset,
        };
    }

    // ============================================================
    // LIST TRANSACTIONS — gabungan topup + withdraw + order payment
    // Untuk halaman "Riwayat Transaksi"
    // ============================================================
    async listTransactions(
        userId: string,
        limit = 20,
        offset = 0
    ) {
        // Ambil topups
        const { data: topups } = await supabaseAdmin
            .from('wallet_topups')
            .select('id, partner_reff, method, amount, nominal, admin_fee, status, created_at, va_number, qris_url')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(limit);

        // Ambil withdrawals
        const { data: withdrawals } = await supabaseAdmin
            .from('wallet_withdrawals')
            .select('id, inquiry_reff, partner_reff, bank_code, account_number, amount, fee_admin, status, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(limit);

        // Ambil wallet transactions (order payment, refund, dll)
        const { data: transactions } = await supabaseAdmin
            .from('wallet_transactions')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(limit);

        // Gabung & normalisasi
        const items = [
            ...(topups ?? []).map((t) => ({
                id: `topup-${t.id}`,
                type: 'topup' as const,
                amount: Number(t.nominal ?? t.amount),
                total_amount: Number(t.amount),
                admin_fee: Number(t.admin_fee ?? 0),
                method: t.method ?? 'va',
                status: t.status,
                reference: t.partner_reff,
                va_number: t.va_number,
                qris_url: t.qris_url,
                created_at: t.created_at,
                description: `Topup via ${t.method?.toUpperCase() ?? 'LinkQu'}`,
            })),
            ...(withdrawals ?? []).map((w) => ({
                id: `withdraw-${w.id}`,
                type: 'withdraw' as const,
                amount: Number(w.amount),
                total_amount: Number(w.amount) + Number(w.fee_admin ?? 0),
                admin_fee: Number(w.fee_admin ?? 0),
                method: 'va',
                status: w.status,
                reference: w.partner_reff,
                bank_code: w.bank_code,
                account_number: w.account_number,
                created_at: w.created_at,
                description: `Withdraw ke ${w.bank_code} ${w.account_number}`,
            })),
            ...(transactions ?? []).map((t) => ({
                id: `tx-${t.id}`,
                type: t.type as any,
                amount: Number(t.amount),
                total_amount: Number(t.amount),
                admin_fee: 0,
                method: 'internal',
                status: 'SUCCESS',
                reference: t.reference_id,
                created_at: t.created_at,
                description: t.description,
            })),
        ];

        // Sort by created_at DESC
        items.sort(
            (a, b) =>
                new Date(b.created_at).getTime() -
                new Date(a.created_at).getTime()
        );

        return {
            items: items.slice(0, limit),
            limit,
            offset,
        };
    }

    // Di wallet.service.ts
    async createOrderPayment(input: {
        orderId: number;
        userId: string;
        amount: number;
        method: 'qris' | 'va';
        bankCode?: string;
    }) {
        logger.info('[wallet.createOrderPayment] START', input);

        // 1. Ambil profile
        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('full_name, email')
            .eq('id', input.userId)
            .single();

        const customerName = profile?.full_name ?? 'Customer';
        const customerEmail = profile?.email ?? DEFAULT_CUSTOMER_EMAIL;

        const partnerReff = `ORDER-${input.orderId}-${Date.now()}`;
        const expired = this.generateExpiredTimestamp(15);

        let endpoint = '';
        let payload: any = {};

        if (input.method === 'qris') {
            endpoint = '/transaction/create/qris';
            const signature = this.signQris({
                amount: input.amount,
                expired,
                partner_reff: partnerReff,
                customer_id: input.userId,
                customer_name: customerName,
                customer_email: customerEmail,
            });
            payload = {
                username: LINKQU_CONFIG.username,
                pin: LINKQU_CONFIG.pin,
                amount: input.amount,
                partner_reff: partnerReff,
                expired,
                signature,
                url_callback: LINKQU_CALLBACK_URL,
                customer_id: input.userId,
                customer_name: customerName,
                customer_email: customerEmail,
            };
        } else {
            if (!input.bankCode) throw ApiError.badRequest('bank_code wajib');
            endpoint = '/transaction/create/va';
            const realBankCode =
                BANK_MAPPING[input.bankCode.toUpperCase()] || input.bankCode;
            const signature = this.signVa({
                amount: input.amount,
                expired,
                bank_code: realBankCode,
                partner_reff: partnerReff,
                customer_id: input.userId,
                customer_name: customerName,
                customer_email: customerEmail,
            });
            payload = {
                username: LINKQU_CONFIG.username,
                pin: LINKQU_CONFIG.pin,
                amount: input.amount,
                bank_code: realBankCode,
                partner_reff: partnerReff,
                expired,
                signature,
                url_callback: LINKQU_CALLBACK_URL,
                customer_id: input.userId,
                customer_name: customerName,
                customer_email: customerEmail,
            };
        }

        // 2. Request ke LinkQu
        const url = `${LINKQU_CONFIG.baseUrl}${endpoint}`;
        console.log('📤 [createOrderPayment] REQUEST', { url, payload });

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'client-id': LINKQU_CONFIG.clientId,
                'client-secret': LINKQU_CONFIG.clientSecret,
                'Content-Type': 'text/plain',
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                Accept: 'application/json, text/plain, */*',
            },
            body: JSON.stringify(payload),
        });

        // ✅ BACA RAW DULU
        const rawText = await response.text();
        console.log('📥 [createOrderPayment] HTTP', response.status);
        console.log('📥 [createOrderPayment] RAW', rawText);

        if (!response.ok) {
            throw ApiError.internal(
                `LinkQu error ${response.status}: ${rawText.slice(0, 200)}`
            );
        }

        let data: any;
        try {
            data = JSON.parse(rawText);
        } catch {
            throw ApiError.internal('Response LinkQu tidak valid');
        }

        console.log(
            '✅ [createOrderPayment] PARSED',
            JSON.stringify(data, null, 2)
        );

        // ═══════════════════════════════════════════════════════════
        // ✅ PARSE VA NUMBER & QR URL DARI BERBAGAI BENTUK RESPONSE
        // ═══════════════════════════════════════════════════════════
        const vaNumber =
            data?.data?.virtual_account ??
            data?.virtual_account ??
            data?.data?.va_number ??
            data?.va_number ??
            data?.data?.vaNumber ??
            data?.vaNumber ??
            null;

        const qrUrl =
            data?.data?.imageqris ??
            data?.imageqris ??
            data?.data?.qr_url ??
            data?.qr_url ??
            data?.data?.qris_url ??
            data?.qris_url ??
            null;

        const expiredFromLinkqu =
            data?.data?.expired ??
            data?.expired ??
            data?.data?.expired_at ??
            data?.expired_at ??
            null;

        console.log('📋 [createOrderPayment] Parsed:', {
            vaNumber,
            qrUrl,
            expiredFromLinkqu,
            method: input.method,
        });

        // ⚠️ Kalau VA method tapi VA number kosong, log warning
        if (input.method === 'va' && !vaNumber) {
            console.error(
                '❌ [createOrderPayment] LinkQu TIDAK mengembalikan va_number! Full response:',
                JSON.stringify(data, null, 2)
            );
        }

        // 3. Simpan ke DB
        const expiredAt = this.parseExpiredToDate(expired);

        await supabaseAdmin.from('order_payments').insert({
            order_id: input.orderId,
            user_id: input.userId,
            partner_reff: partnerReff,
            method: input.method,
            amount: input.amount,
            bank_code: input.bankCode ?? null,
            va_number: vaNumber,
            qr_url: qrUrl,
            status: 'PENDING',
            raw_response: data,
            expired_at: expiredAt,
        });

        return {
            ...data,
            partner_reff: partnerReff,
            va_number: vaNumber,        // ✅ hasil parse lengkap
            qr_url: qrUrl,              // ✅ hasil parse lengkap
            expired_at: expiredAt,
        };
    }
    // Di wallet.service.ts
    // Bayar order pakai saldo customer. Potong saldo di bawah lock + guard,
    // jadi dua pembayaran bersamaan tidak bisa membuat saldo negatif.
    async payWithWallet(userId: string, orderId: number, amount: number) {
        logger.info('[wallet.payWithWallet] START', { userId, orderId, amount });

        const newBalance = await this.mutateCustomer(userId, (balance) => {
            if (balance < amount) {
                throw ApiError.badRequest(
                    `Saldo tidak cukup. Butuh Rp${amount.toLocaleString('id-ID')}, ` +
                    `saldo: Rp${balance.toLocaleString('id-ID')}`
                );
            }
            const nb = balance - amount;
            return {
                newBalance: nb,
                tx: {
                    type: 'order_payment',
                    amount,
                    reference_id: `ORDER-${orderId}`,
                    description: `Pembayaran order #${orderId}`,
                },
                result: nb,
            };
        });

        logger.info('[wallet.payWithWallet] ✅ Sukses', {
            userId,
            orderId,
            amount,
            newBalance,
        });

        return { new_balance: newBalance, amount };
    }
    // ============================================================
    // SAVED ACCOUNTS
    // ============================================================
    async listSavedAccounts(userId: string) {
        const { data, error } = await supabaseAdmin
            .from('saved_accounts')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: true });
        if (error) throw ApiError.internal('Gagal ambil rekening');
        return data ?? [];
    }

    async saveAccount(userId: string, dto: {
        bank_code: string; account_number: string; account_name: string;
    }) {
        const { count } = await supabaseAdmin
            .from('saved_accounts')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId);

        if ((count ?? 0) >= 2) {
            throw ApiError.badRequest('Maksimal 2 rekening tersimpan. Hapus salah satu dulu.');
        }

        const { data, error } = await supabaseAdmin
            .from('saved_accounts')
            .insert({
                user_id: userId,
                bank_code: dto.bank_code.toUpperCase(),
                account_number: dto.account_number,
                account_name: dto.account_name,
            })
            .select()
            .single();

        if (error) {
            if (error.code === '23505') throw ApiError.badRequest('Rekening sudah tersimpan');
            throw ApiError.internal('Gagal simpan rekening');
        }
        return data;
    }

    async deleteAccount(userId: string, id: number) {
        const { error } = await supabaseAdmin
            .from('saved_accounts')
            .delete()
            .eq('id', id)
            .eq('user_id', userId);
        if (error) throw ApiError.internal('Gagal hapus rekening');
    }

    // ============================================================
    // HELPER — FORMAT EXPIRED
    // ============================================================
    private formatExpiredDisplay(expired: string): string {
        const dd = expired.slice(6, 8);
        const mm = expired.slice(4, 6);
        const yyyy = expired.slice(0, 4);
        const hh = expired.slice(8, 10);
        const mi = expired.slice(10, 12);
        return `${dd}/${mm}/${yyyy} ${hh}:${mi} WIB`;
    }

    // ============================================================
    // HELPER — SIGNATURE LINKQU
    // ============================================================
    signVa(d: {
        amount: number; expired: string; bank_code: string; partner_reff: string;
        customer_id: string; customer_name: string; customer_email: string;
    }) {
        const path = '/transaction/create/va';
        const method = 'POST';
        const raw = `${d.amount}${d.expired}${d.bank_code}${d.partner_reff}${d.customer_id}${d.customer_name}${d.customer_email}${LINKQU_CONFIG.clientId}`;
        const cleaned = raw.replace(/[^0-9a-zA-Z]/g, '').toLowerCase();
        const signString = path + method + cleaned;

        console.log('🔐 [signVa] ================================');
        console.log('🔐 [signVa] amount:', d.amount);
        console.log('🔐 [signVa] expired:', d.expired);
        console.log('🔐 [signVa] bank_code:', d.bank_code);
        console.log('🔐 [signVa] partner_reff:', d.partner_reff);
        console.log('🔐 [signVa] customer_id:', d.customer_id);
        console.log('🔐 [signVa] customer_name:', d.customer_name);
        console.log('🔐 [signVa] customer_email:', d.customer_email);
        console.log('🔐 [signVa] clientId:', LINKQU_CONFIG.clientId);
        console.log('🔐 [signVa] RAW:', raw);
        console.log('🔐 [signVa] CLEANED:', cleaned);
        console.log('🔐 [signVa] SIGN STRING:', signString);
        console.log('🔐 [signVa] SERVER KEY:', LINKQU_CONFIG.serverKey);
        console.log('🔐 [signVa] ================================');

        return crypto.createHmac('sha256', LINKQU_CONFIG.serverKey)
            .update(signString).digest('hex');
    }

    signQris(d: {
        amount: number; expired: string; partner_reff: string;
        customer_id: string; customer_name: string; customer_email: string;
    }) {
        const path = '/transaction/create/qris';
        const method = 'POST';
        const raw = `${d.amount}${d.expired}${d.partner_reff}${d.customer_id}${d.customer_name}${d.customer_email}${LINKQU_CONFIG.clientId}`;
        const cleaned = raw.replace(/[^0-9a-zA-Z]/g, '').toLowerCase();
        const signString = path + method + cleaned;

        console.log('🔐 [signQris] ================================');
        console.log('🔐 [signQris] amount:', d.amount);
        console.log('🔐 [signQris] expired:', d.expired);
        console.log('🔐 [signQris] partner_reff:', d.partner_reff);
        console.log('🔐 [signQris] customer_id:', d.customer_id);
        console.log('🔐 [signQris] customer_name:', d.customer_name);
        console.log('🔐 [signQris] customer_email:', d.customer_email);
        console.log('🔐 [signQris] clientId:', LINKQU_CONFIG.clientId);
        console.log('🔐 [signQris] RAW:', raw);
        console.log('🔐 [signQris] CLEANED:', cleaned);
        console.log('🔐 [signQris] SIGN STRING:', signString);
        console.log('🔐 [signQris] SERVER KEY:', LINKQU_CONFIG.serverKey);
        console.log('🔐 [signQris] ================================');

        return crypto.createHmac('sha256', LINKQU_CONFIG.serverKey)
            .update(signString).digest('hex');
    }

    generateExpiredTimestamp(minutes = 15) {
        const nowWIB = new Date(Date.now() + 7 * 60 * 60 * 1000);
        nowWIB.setMinutes(nowWIB.getMinutes() + minutes);

        const pad = (n: number) => n.toString().padStart(2, '0');
        return (
            nowWIB.getUTCFullYear() +
            pad(nowWIB.getUTCMonth() + 1) +
            pad(nowWIB.getUTCDate()) +
            pad(nowWIB.getUTCHours()) +
            pad(nowWIB.getUTCMinutes()) +
            pad(nowWIB.getUTCSeconds())
        );
    }

    parseExpiredToDate(expired: string): string {
        const y = expired.slice(0, 4), m = expired.slice(4, 6), d = expired.slice(6, 8);
        const hh = expired.slice(8, 10), mm = expired.slice(10, 12), ss = expired.slice(12, 14);
        return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}+07:00`).toISOString();
    }
}

export const walletService = new WalletService();