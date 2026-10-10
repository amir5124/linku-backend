// src/modules/wallet/wallet.service.ts
import axios from 'axios';
import crypto from 'crypto';
import { supabaseAdmin } from '../../config/supabase';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../config/logger';
import { notificationService } from '../notification/notification.service';  // ✅ TAMBAH

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
    // SETTLE ORDER
    // ============================================================
    async settleOrder(orderId: number) {
        const { data: orderRaw, error: oErr } = await supabaseAdmin
            .from('orders')
            .select(`
                id, type, status, driver_id, customer_id,
                delivery_fee, driver_earning, total_fare,
                tariff_code, payment_method, payment_status,
                settled_at, commission_amount, commission_rate,
                platform_earning, settlement_type
            `)
            .eq('id', orderId)
            .single();

        if (oErr || !orderRaw) throw ApiError.notFound('Order tidak ditemukan');

        const order = orderRaw as unknown as OrderRow;

        if (order.status !== 'completed') throw ApiError.badRequest('Order belum completed');
        if (!order.driver_id) throw ApiError.badRequest('Order tidak punya driver');
        if (order.settled_at) {
            logger.info('Order sudah di-settle, skip', { orderId });
            return { already_settled: true };
        }

        const commissionRate = await this.getCommissionRate(order.type, order.tariff_code);
        const commissionBase = Number(order.delivery_fee) || 0;
        const commissionAmount = Math.round(commissionBase * commissionRate);
        const driverEarning = Number(order.driver_earning) || 0;

        const isCash = order.payment_method === 'cash';
        const settlementType = isCash ? 'cash' : 'gateway';

        await supabaseAdmin
            .from('driver_wallets')
            .upsert(
                { driver_id: order.driver_id },
                { onConflict: 'driver_id', ignoreDuplicates: true }
            );

        const { data: walletRaw, error: wErr } = await supabaseAdmin
            .from('driver_wallets')
            .select('*')
            .eq('driver_id', order.driver_id)
            .single();

        if (wErr || !walletRaw) throw ApiError.internal('Wallet tidak ditemukan');

        const wallet = walletRaw as unknown as WalletRow;

        let newBalance = Number(wallet.balance);
        let newCashDebt = Number(wallet.cash_debt);
        const ledgerEntries: any[] = [];

        if (isCash) {
            newCashDebt = newCashDebt + commissionAmount;

            ledgerEntries.push({
                driver_id: order.driver_id, order_id: order.id,
                entry_type: 'earning_cash', amount: driverEarning, direction: 'in',
                balance_after: newBalance, cash_debt_after: newCashDebt,
                description: `Pendapatan cash order #${order.id}`,
                metadata: { payment_method: 'cash' },
            });

            ledgerEntries.push({
                driver_id: order.driver_id, order_id: order.id,
                entry_type: 'commission_cash', amount: commissionAmount, direction: 'out',
                balance_after: newBalance, cash_debt_after: newCashDebt,
                description: `Komisi cash order #${order.id} (${(commissionRate * 100).toFixed(1)}%)`,
                metadata: { commission_rate: commissionRate, commission_base: commissionBase },
            });
        } else {
            const netEarning = driverEarning - commissionAmount;
            let debtPaid = 0;
            if (newCashDebt > 0) {
                debtPaid = Math.min(newCashDebt, netEarning);
                newCashDebt = newCashDebt - debtPaid;
            }
            const balanceCredit = netEarning - debtPaid;
            newBalance = newBalance + balanceCredit;

            ledgerEntries.push({
                driver_id: order.driver_id, order_id: order.id,
                entry_type: 'earning_gateway', amount: netEarning, direction: 'in',
                balance_after: newBalance, cash_debt_after: newCashDebt,
                description: `Pendapatan order #${order.id} (net setelah komisi)`,
                metadata: { payment_method: order.payment_method },
            });

            if (debtPaid > 0) {
                ledgerEntries.push({
                    driver_id: order.driver_id, order_id: order.id,
                    entry_type: 'debt_payment', amount: debtPaid, direction: 'out',
                    balance_after: newBalance, cash_debt_after: newCashDebt,
                    description: `Pelunasan utang cash`,
                    metadata: { debt_paid: debtPaid },
                });
            }
        }

        const { error: walletErr } = await supabaseAdmin
            .from('driver_wallets')
            .update({
                balance: newBalance,
                cash_debt: newCashDebt,
                total_earning: Number(wallet.total_earning) + driverEarning,
                total_commission_paid:
                    Number(wallet.total_commission_paid) + (isCash ? 0 : commissionAmount),
                total_commission_owed: newCashDebt,
            })
            .eq('driver_id', order.driver_id);

        if (walletErr) {
            logger.error('Update wallet gagal', { error: walletErr, orderId });
            throw ApiError.internal('Gagal update wallet');
        }

        const { error: ledgerErr } = await supabaseAdmin
            .from('driver_wallet_ledger')
            .insert(ledgerEntries);

        if (ledgerErr) logger.error('Insert ledger gagal', { error: ledgerErr, orderId });

        await supabaseAdmin
            .from('orders')
            .update({
                commission_rate: commissionRate,
                commission_amount: commissionAmount,
                platform_earning: (Number(order.platform_earning) || 0) + commissionAmount,
                settled_at: new Date().toISOString(),
                settlement_type: settlementType,
            })
            .eq('id', order.id);

        logger.info('Order settled', {
            orderId: order.id, driverId: order.driver_id, settlementType,
            commissionAmount, newBalance, newCashDebt,
        });

        return {
            order_id: order.id, settlement_type: settlementType,
            commission_rate: commissionRate, commission_amount: commissionAmount,
            driver_earning: driverEarning,
            new_balance: newBalance, new_cash_debt: newCashDebt,
        };
    }

    // ============================================================
    // GET COMMISSION RATE
    // ============================================================
    async getCommissionRate(orderType: string, tariffCode?: string | null): Promise<number> {
        const { data, error } = await supabaseAdmin.rpc('get_commission_rate', {
            p_order_type: orderType,
            p_tariff_code: tariffCode ?? null,
        });

        if (error || data == null) {
            logger.warn('Gagal ambil commission rate, pakai default', { error, orderType, tariffCode });
            return orderType === 'food' ? 0.15 : 0.08;
        }

        return Number(data);
    }

    // ============================================================
    // REQUEST PAYOUT (driver only)
    // ============================================================
    async requestPayout(
        driverId: string,
        amount: number,
        bankInfo: { bank_code: string; bank_name: string; account_number: string; account_name: string; }
    ) {
        if (amount <= 0) throw ApiError.badRequest('Jumlah harus > 0');

        const wallet = await this.getWallet(driverId, 'driver');

        if (wallet.balance < amount) {
            throw ApiError.badRequest(
                `Saldo tidak cukup. Saldo tersedia: Rp${wallet.balance.toLocaleString('id-ID')}`
            );
        }

        if (wallet.cash_debt > 0) {
            throw ApiError.badRequest(
                `Lunasi utang cash dulu (Rp${wallet.cash_debt.toLocaleString('id-ID')})`
            );
        }

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
        const newBalance = wallet.balance - amount;

        await supabaseAdmin
            .from('driver_wallets')
            .update({ balance: newBalance })
            .eq('driver_id', driverId);

        await supabaseAdmin.from('driver_wallet_ledger').insert({
            driver_id: driverId,
            entry_type: 'payout',
            amount,
            direction: 'out',
            balance_after: newBalance,
            cash_debt_after: wallet.cash_debt,
            description: `Request payout #${payout.id}`,
            metadata: { payout_id: payout.id, ...bankInfo },
        });

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
        const customerEmail = profile?.email ?? 'noreply@warung.id';

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
                url_callback: 'https://linku.siappgo.id/api/wallet/callback',
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
                url_callback: 'https://linku.siappgo.id/api/wallet/callback',
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
    // ============================================================
    async withdrawInquiry(userId: string, dto: {
        amount: number;
        bank_code: string;
        account_number: string;
        role?: 'driver' | 'customer';
    }) {
        const role = dto.role ?? 'driver';
        const wallet = role === 'driver'
            ? await this.getWallet(userId, 'driver')
            : await this.getWallet(userId, 'customer');

        // ═══════════════════════════════════════════════════════════
        // ✅ HITUNG FEE ADMIN WITHDRAW
        // ═══════════════════════════════════════════════════════════
        const WITHDRAW_FEE = 3000;
        const totalDeduction = dto.amount + WITHDRAW_FEE;

        // Cek saldo terhadap TOTAL (nominal + fee)
        if (wallet.balance < totalDeduction) {
            throw ApiError.badRequest(
                `Saldo tidak cukup. Butuh Rp${totalDeduction.toLocaleString('id-ID')} ` +
                `(nominal Rp${dto.amount.toLocaleString('id-ID')} + fee Rp${WITHDRAW_FEE.toLocaleString('id-ID')}). ` +
                `Saldo: Rp${wallet.balance.toLocaleString('id-ID')}`
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

        // ✅ Signature pakai nominal yang ditransfer (bukan total)
        const sigData = {
            amount: dto.amount,              // ⬅️ nominal ke rekening
            accountnumber: dto.account_number,
            bankcode: realBankCode,
            partnerreff: inquiryReff,
        };
        const signature = crypto
            .createHmac('sha256', LINKQU_CONFIG.clientSecret)
            .update(JSON.stringify(sigData))
            .digest('hex');

        // ✅ Payload LinkQu: amount = nominal (bukan total)
        const params = {
            username: LINKQU_CONFIG.username,
            pin: LINKQU_CONFIG.pin,
            bankcode: realBankCode,
            accountnumber: dto.account_number,
            amount: dto.amount,              // ⬅️ nominal ke rekening
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

            // ═══════════════════════════════════════════════════════════
            // ✅ SIMPAN DENGAN fee_admin
            // ═══════════════════════════════════════════════════════════
            await supabaseAdmin.from('wallet_withdrawals').insert({
                user_id: userId,
                inquiry_reff: response.data.inquiry_reff ?? inquiryReff,
                partner_reff: inquiryReff,
                bank_code: realBankCode,
                account_number: dto.account_number,
                amount: dto.amount,              // ⬅️ nominal ke rekening (Rp10.000)
                fee_admin: WITHDRAW_FEE,         // ⬅️ fee (Rp2.500)
                status: 'INQUIRY',
                raw_response: response.data,
            });

            return {
                ...response.data,
                partner_reff: inquiryReff,
                amount: dto.amount,
                fee_admin: WITHDRAW_FEE,
                total_deduction: totalDeduction,
            };
        } catch (err: any) {
            logger.error('Withdraw inquiry error', {
                error: err.response?.data || err.message,
            });
            throw ApiError.internal('Gagal inquiry withdraw');
        }
    }
    // ============================================================
    // WITHDRAW — EXECUTE
    // ============================================================
    async withdrawExecute(
        userId: string,
        inquiryReff: string,
        role: 'driver' | 'customer' = 'driver'
    ) {
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

        // ═══════════════════════════════════════════════════════════
        // ✅ HITUNG FEE ADMIN WITHDRAW
        // ═══════════════════════════════════════════════════════════
        const feeAdmin = Number(inq.fee_admin ?? 3000);      // Rp2.500
        const nominalTransfer = Number(inq.amount);          // Rp10.000
        const totalDeduction = nominalTransfer + feeAdmin;   // Rp12.500

        const isEmoney = E_WALLET_CODES.includes(inq.bank_code.toUpperCase());
        let endpoint = '/transaction/withdraw/payment';
        let method: 'GET' | 'POST' = 'POST';
        if (isEmoney) {
            endpoint = '/transaction/reload/payment';
            method = 'GET';
        } else if (VA_CODES.includes(inq.bank_code.toUpperCase())) {
            endpoint = '/transaction/transferva/payment';
        }

        const partnerReffPay = `PAY${Date.now()}-${crypto
            .randomBytes(4)
            .toString('hex')}`;

        // ✅ Signature pakai nominal transfer (bukan total)
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

        // ✅ Payload LinkQu: amount = nominal (yang dikirim ke rekening)
        const payload = {
            username: LINKQU_CONFIG.username,
            pin: LINKQU_CONFIG.pin,
            bankcode: inq.bank_code,
            accountnumber: inq.account_number,
            amount: nominalTransfer,        // ⬅️ nominal Rp10.000
            partner_reff: partnerReffPay,
            inquiry_reff: inquiryReff,
            signature,
            remark: 'Withdraw Mitra',
            url_callback: 'https://linku.siappgo.id/api/wallet/callback',
        };

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
                    : await axios.post(
                        `${LINKQU_CONFIG.baseUrl}${endpoint}`,
                        payload,
                        {
                            headers: {
                                'client-id': LINKQU_CONFIG.clientId,
                                'client-secret': LINKQU_CONFIG.clientSecret,
                            },
                        }
                    );

            const finalStatus =
                response.data.status === 'SUCCESS' ? 'SUCCESS' : 'PENDING';

            // ═══════════════════════════════════════════════════════════
            // ✅ UPDATE STATUS + notified_at (kalau langsung SUCCESS)
            // ═══════════════════════════════════════════════════════════
            const notifiedAtNow =
                finalStatus === 'SUCCESS' ? new Date().toISOString() : null;

            await supabaseAdmin
                .from('wallet_withdrawals')
                .update({
                    status: finalStatus,
                    partner_reff_pay: partnerReffPay,
                    notified_at: notifiedAtNow,
                    raw_payment_response: response.data,
                    updated_at: new Date().toISOString(),
                })
                .eq('inquiry_reff', inquiryReff);

            // ═══════════════════════════════════════════════════════════
            // ✅ UPDATE WALLET: potong saldo sebesar TOTAL (nominal + fee)
            // ═══════════════════════════════════════════════════════════
            if (role === 'driver') {
                const driverWallet = await this.getWallet(userId, 'driver');
                const newBalance = driverWallet.balance - totalDeduction; // ⬅️ Rp12.500

                await supabaseAdmin
                    .from('driver_wallets')
                    .update({ balance: newBalance })
                    .eq('driver_id', userId);

                await supabaseAdmin.from('driver_wallet_ledger').insert({
                    driver_id: userId,
                    entry_type: 'withdraw',
                    amount: totalDeduction,        // ⬅️ total Rp12.500
                    direction: 'out',
                    balance_after: newBalance,
                    cash_debt_after: driverWallet.cash_debt,
                    description: `Withdraw Rp${nominalTransfer.toLocaleString(
                        'id-ID'
                    )} ke ${inq.bank_code} ${inq.account_number} + fee Rp${feeAdmin.toLocaleString(
                        'id-ID'
                    )}`,
                    metadata: {
                        partner_reff: partnerReffPay,
                        nominal: nominalTransfer,
                        fee_admin: feeAdmin,
                        total_deduction: totalDeduction,
                    },
                });
            } else {
                const customerWallet = await this.getWallet(userId, 'customer');
                const newBalance = customerWallet.balance - totalDeduction; // ⬅️ Rp12.500

                await supabaseAdmin
                    .from('wallets')
                    .update({ balance: newBalance })
                    .eq('user_id', userId);

                await supabaseAdmin.from('wallet_transactions').insert({
                    user_id: userId,
                    type: 'withdraw',
                    amount: totalDeduction,        // ⬅️ total Rp12.500
                    balance_after: newBalance,
                    reference_id: partnerReffPay,
                    description: `Withdraw Rp${nominalTransfer.toLocaleString(
                        'id-ID'
                    )} ke ${inq.bank_code} ${inq.account_number} + fee Rp${feeAdmin.toLocaleString(
                        'id-ID'
                    )}`,
                });
            }

            // ═══════════════════════════════════════════════════════════
            // ✅ NOTIFIKASI
            // - SUCCESS  → "Penarikan Berhasil" (langsung)
            // - PENDING  → "Penarikan Diproses"
            // ═══════════════════════════════════════════════════════════
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

                    logger.info('✅ Withdraw SUCCESS notif sent (execute)', {
                        inquiry_reff: inquiryReff,
                        userId,
                        nominalTransfer,
                        feeAdmin,
                        totalDeduction,
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

                    logger.info('⏳ Withdraw PENDING notif sent (execute)', {
                        inquiry_reff: inquiryReff,
                        userId,
                        nominalTransfer,
                        feeAdmin,
                        totalDeduction,
                    });
                }
            } catch (err: any) {
                logger.warn('Gagal kirim notif withdraw (execute)', {
                    inquiry_reff: inquiryReff,
                    error: err.message,
                });
            }

            return {
                ...response.data,
                internal_status: finalStatus,
                partner_reff: partnerReffPay,
                amount: nominalTransfer,
                fee_admin: feeAdmin,
                total_deduction: totalDeduction,
            };
        } catch (err: any) {
            logger.error('Withdraw execute error', {
                error: err.response?.data || err.message,
            });
            throw ApiError.internal('Gagal memproses withdraw');
        }
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
        const customerEmail = profile?.email ?? 'noreply@warung.id';

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
                url_callback: 'https://linku.siappgo.id/api/wallet/callback',
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
                url_callback: 'https://linku.siappgo.id/api/wallet/callback',
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
    async payWithWallet(userId: string, orderId: number, amount: number) {
        logger.info('[wallet.payWithWallet] START', { userId, orderId, amount });

        // 1. Cek saldo
        const wallet = await this.getWallet(userId, 'customer');
        if (wallet.balance < amount) {
            throw ApiError.badRequest(
                `Saldo tidak cukup. Butuh Rp${amount.toLocaleString('id-ID')}, ` +
                `saldo: Rp${wallet.balance.toLocaleString('id-ID')}`
            );
        }

        // 2. Potong saldo (race-safe)
        const newBalance = wallet.balance - amount;

        const { error: updateErr } = await supabaseAdmin
            .from('wallets')
            .update({ balance: newBalance, updated_at: new Date().toISOString() })
            .eq('user_id', userId);

        if (updateErr) {
            throw ApiError.internal('Gagal potong saldo: ' + updateErr.message);
        }

        // 3. Insert transaksi
        await supabaseAdmin.from('wallet_transactions').insert({
            user_id: userId,
            type: 'order_payment',
            amount,
            balance_after: newBalance,
            reference_id: `ORDER-${orderId}`,
            description: `Pembayaran order #${orderId}`,
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