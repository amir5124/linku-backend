// src/modules/wallet/wallet.callback.ts
import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../../config/supabase';
import { logger } from '../../config/logger';
import { notificationService } from '../notification/notification.service';

const router = Router();

// ============================================================
// KONSTANTA FEE ADMIN
// ============================================================
const FEE_ADMIN_VA = 2500;
const FEE_ADMIN_BCA = 4000;
const FEE_ADMIN_QRIS_PERCENT = 0.008;

function calculateAdminFee(
    method: string,
    bankCode: string | null,
    amount: number
): number {
    const m = (method ?? '').toLowerCase();
    if (m === 'qris') return Math.round(amount * FEE_ADMIN_QRIS_PERCENT);
    if (bankCode === '014') return FEE_ADMIN_BCA;
    return FEE_ADMIN_VA;
}

// ============================================================
// CALLBACK LINKQU
// ============================================================
router.post('/callback', async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const { partner_reff, status, va_code, serialnumber } = body;

    logger.info('📥 [LinkQu Callback]', {
        partner_reff,
        status,
        va_code,
    });

    if (!partner_reff) return res.status(200).send('OK');

    try {
        // ═══════════════════════════════════════════════════════
        // 1. Cek TOPUP
        // ═══════════════════════════════════════════════════════
        const { data: topup } = await supabaseAdmin
            .from('wallet_topups')
            .select('*')
            .eq('partner_reff', partner_reff)
            .maybeSingle();

        if (topup) {
            await handleTopupCallback(
                topup,
                status,
                va_code,
                serialnumber
            );
            return res
                .status(200)
                .json({ status: 'SUCCESS', message: 'Topup diproses' });
        }

        // ═══════════════════════════════════════════════════════
        // 2. Cek WITHDRAWAL
        // ═══════════════════════════════════════════════════════
        const { data: wd } = await supabaseAdmin
            .from('wallet_withdrawals')
            .select('*')
            .or(
                `partner_reff.eq.${partner_reff},partner_reff_pay.eq.${partner_reff}`
            )
            .maybeSingle();

        if (wd) {
            await handleWithdrawCallback(wd, status);
            return res
                .status(200)
                .json({ status: 'SUCCESS', message: 'Withdraw diproses' });
        }

        // ═══════════════════════════════════════════════════════
        // 3. ✅ BARU: Cek ORDER PAYMENT (QRIS/VA untuk order)
        // ═══════════════════════════════════════════════════════
        const { data: orderPayment } = await supabaseAdmin
            .from('order_payments')
            .select('*')
            .eq('partner_reff', partner_reff)
            .maybeSingle();

        if (orderPayment) {
            await handleOrderPaymentCallback(orderPayment, status);
            return res
                .status(200)
                .json({
                    status: 'SUCCESS',
                    message: 'Order payment diproses',
                });
        }

        // ═══════════════════════════════════════════════════════
        // 4. Tidak dikenal
        // ═══════════════════════════════════════════════════════
        logger.warn('⚠️ Callback: partner_reff tidak dikenal', {
            partner_reff,
        });
        return res.status(200).send('OK');
    } catch (err: any) {
        logger.error('❌ Callback error', {
            error: err.message,
            partner_reff,
        });
        return res.status(200).send('OK');
    }
});

// ============================================================
// HANDLER: TOPUP CALLBACK
// ============================================================
async function handleTopupCallback(
    topup: any,
    status: string,
    va_code?: string,
    serialnumber?: string
) {
    const isSuccess =
        status === 'SUCCESS' ||
        status === 'SETTLED' ||
        status === 'PAID';

    // Idempotency — skip kalau sudah SUCCESS
    if (topup.status === 'SUCCESS') {
        logger.info('ℹ️ Topup sudah SUCCESS, skip', {
            partner_reff: topup.partner_reff,
        });
        return;
    }

    // Handle gagal / expired
    if (!isSuccess) {
        if (status === 'FAILED' || status === 'EXPIRED') {
            await supabaseAdmin
                .from('wallet_topups')
                .update({
                    status: 'FAILED',
                    updated_at: new Date().toISOString(),
                })
                .eq('id', topup.id);

            const nominal = Number(topup.nominal ?? topup.amount);

            await notificationService.sendToUser(topup.user_id, {
                title: 'Topup Gagal',
                body: `Topup Rp${nominal.toLocaleString(
                    'id-ID'
                )} gagal atau kadaluarsa.`,
                data: {
                    type: 'topup_failed',
                    amount: nominal,
                    partner_reff: topup.partner_reff,
                },
            });

            logger.info('❌ Topup FAILED', {
                partner_reff: topup.partner_reff,
            });
        }
        return;
    }

    // ═══════════════════════════════════════════════════════════
    // HITUNG NOMINAL & FEE
    // ═══════════════════════════════════════════════════════════
    const userId = topup.user_id;

    const nominal = Number(topup.nominal ?? topup.amount);
    const adminFee = Number(topup.admin_fee ?? 0);
    const totalBayar = Number(topup.amount);

    // ✅ Yang masuk saldo = nominal
    const netAmount = nominal;

    logger.info('💰 Fee admin', {
        partner_reff: topup.partner_reff,
        method: topup.method,
        bankCode: topup.bank_code,
        totalBayar,
        nominal,
        adminFee,
        netAmount,
    });

    // ═══════════════════════════════════════════════════════════
    // CEK APAKAH USER = DRIVER
    // ═══════════════════════════════════════════════════════════
    const { data: driverProfile } = await supabaseAdmin
        .from('driver_profiles')
        .select('user_id')
        .eq('user_id', userId)
        .maybeSingle();

    const isDriver = !!driverProfile;

    // ═══════════════════════════════════════════════════════════
    // DRIVER
    // ═══════════════════════════════════════════════════════════
    if (isDriver) {
        await supabaseAdmin
            .from('driver_wallets')
            .upsert(
                { driver_id: userId },
                { onConflict: 'driver_id', ignoreDuplicates: true }
            );

        const { data: wallet } = await supabaseAdmin
            .from('driver_wallets')
            .select('*')
            .eq('driver_id', userId)
            .single();

        let newBalance = Number(wallet?.balance ?? 0);
        let newCashDebt = Number(wallet?.cash_debt ?? 0);
        let amountLeft = netAmount;

        // ── LANGKAH 1: Lunasi utang cash DULU ──
        let debtPaid = 0;
        if (newCashDebt > 0) {
            debtPaid = Math.min(newCashDebt, amountLeft);
            newCashDebt = newCashDebt - debtPaid;
            amountLeft = amountLeft - debtPaid;
        }

        // ── LANGKAH 2: Sisa masuk saldo ──
        newBalance = newBalance + amountLeft;

        // ── LANGKAH 3: Update wallet ──
        await supabaseAdmin
            .from('driver_wallets')
            .update({
                balance: newBalance,
                cash_debt: newCashDebt,
                total_commission_owed: newCashDebt,
                updated_at: new Date().toISOString(),
            })
            .eq('driver_id', userId);

        // ── LANGKAH 4: Ledger topup ──
        await supabaseAdmin.from('driver_wallet_ledger').insert({
            driver_id: userId,
            entry_type: 'topup',
            amount: netAmount,
            direction: 'in',
            balance_after: newBalance,
            cash_debt_after: newCashDebt,
            description: `Topup via ${topup.method?.toUpperCase() ?? 'LinkQu'
                } (nominal Rp${nominal.toLocaleString(
                    'id-ID'
                )} + fee Rp${adminFee.toLocaleString('id-ID')})`,
            metadata: {
                partner_reff: topup.partner_reff,
                va_code,
                serialnumber,
                total_bayar: totalBayar,
                nominal,
                admin_fee: adminFee,
                net_amount: netAmount,
                debt_paid: debtPaid,
            },
        });

        // ── LANGKAH 5: Ledger pelunasan utang ──
        if (debtPaid > 0) {
            await supabaseAdmin.from('driver_wallet_ledger').insert({
                driver_id: userId,
                entry_type: 'debt_payment',
                amount: debtPaid,
                direction: 'out',
                balance_after: newBalance,
                cash_debt_after: newCashDebt,
                description: 'Pelunasan utang cash dari topup',
                metadata: {
                    debt_paid: debtPaid,
                    source: 'topup',
                    partner_reff: topup.partner_reff,
                },
            });
        }

        logger.info('✅ Topup SUCCESS (driver)', {
            partner_reff: topup.partner_reff,
            userId,
            totalBayar,
            nominal,
            adminFee,
            netAmount,
            debtPaid,
            newBalance,
            newCashDebt,
        });
    }

    // ═══════════════════════════════════════════════════════════
    // CUSTOMER
    // ═══════════════════════════════════════════════════════════
    else {
        await supabaseAdmin
            .from('wallets')
            .upsert(
                { user_id: userId },
                { onConflict: 'user_id', ignoreDuplicates: true }
            );

        const { data: wallet } = await supabaseAdmin
            .from('wallets')
            .select('*')
            .eq('user_id', userId)
            .single();

        const newBalance = Number(wallet?.balance ?? 0) + netAmount;

        await supabaseAdmin
            .from('wallets')
            .update({
                balance: newBalance,
                updated_at: new Date().toISOString(),
            })
            .eq('user_id', userId);

        await supabaseAdmin.from('wallet_transactions').insert({
            user_id: userId,
            type: 'topup',
            amount: netAmount,
            balance_after: newBalance,
            reference_id: topup.partner_reff,
            description: `Topup via ${topup.method?.toUpperCase() ?? 'LinkQu'
                } (nominal Rp${nominal.toLocaleString(
                    'id-ID'
                )} + fee Rp${adminFee.toLocaleString('id-ID')})`,
        });

        logger.info('✅ Topup SUCCESS (customer)', {
            partner_reff: topup.partner_reff,
            userId,
            totalBayar,
            nominal,
            adminFee,
            netAmount,
            newBalance,
        });
    }

    // ═══════════════════════════════════════════════════════════
    // UPDATE STATUS TOPUP → SUCCESS
    // ═══════════════════════════════════════════════════════════
    await supabaseAdmin
        .from('wallet_topups')
        .update({
            status: 'SUCCESS',
            updated_at: new Date().toISOString(),
        })
        .eq('id', topup.id);

    // ═══════════════════════════════════════════════════════════
    // NOTIFIKASI SUKSES
    // ═══════════════════════════════════════════════════════════
    await notificationService.sendToUser(userId, {
        title: 'Topup Berhasil',
        body: `Saldo Rp${netAmount.toLocaleString(
            'id-ID'
        )} sudah masuk (fee admin Rp${adminFee.toLocaleString('id-ID')}).`,
        data: {
            type: 'topup_success',
            amount: netAmount,
            nominal,
            total_bayar: totalBayar,
            admin_fee: adminFee,
            partner_reff: topup.partner_reff,
        },
    });
}

// ============================================================
// HANDLER: WITHDRAW CALLBACK
// ============================================================
async function handleWithdrawCallback(wd: any, status: string) {
    const isSuccess = status === 'SUCCESS' || status === 'SETTLED';
    const isFailed = status === 'FAILED' || status === 'REJECTED';

    // ═══════════════════════════════════════════════════════════
    // IDEMPOTENCY
    // ═══════════════════════════════════════════════════════════
    if (wd.status === 'SUCCESS' && wd.notified_at) {
        logger.info('ℹ️ Withdraw sudah SUCCESS & dinotif, skip', {
            inquiry_reff: wd.inquiry_reff,
        });
        return;
    }

    // ═══════════════════════════════════════════════════════════
    // HITUNG NOMINAL & FEE
    // ═══════════════════════════════════════════════════════════
    const nominal = Number(wd.amount ?? 0);
    const feeAdmin = Number(wd.fee_admin ?? 3000);
    const totalDeduction = nominal + feeAdmin;

    // ═══════════════════════════════════════════════════════════
    // HANDLE SUCCESS
    // ═══════════════════════════════════════════════════════════
    if (isSuccess) {
        await supabaseAdmin
            .from('wallet_withdrawals')
            .update({
                status: 'SUCCESS',
                notified_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq('id', wd.id);

        if (!wd.notified_at) {
            await notificationService.sendToUser(wd.user_id, {
                title: 'Penarikan Berhasil',
                body:
                    `Penarikan Rp${nominal.toLocaleString('id-ID')} berhasil. ` +
                    `Fee admin Rp${feeAdmin.toLocaleString('id-ID')}. ` +
                    `Total dipotong Rp${totalDeduction.toLocaleString('id-ID')}.`,
                data: {
                    type: 'withdraw_success',
                    amount: nominal,
                    fee_admin: feeAdmin,
                    total_deduction: totalDeduction,
                    inquiry_reff: wd.inquiry_reff,
                },
            });

            logger.info('✅ Withdraw SUCCESS notif sent (callback)', {
                inquiry_reff: wd.inquiry_reff,
                nominal,
                feeAdmin,
                totalDeduction,
            });
        }
        return;
    }

    // ═══════════════════════════════════════════════════════════
    // HANDLE FAILED (+ REFUND TOTAL)
    // ═══════════════════════════════════════════════════════════
    if (isFailed) {
        const userId = wd.user_id;

        const { data: driverProfile } = await supabaseAdmin
            .from('driver_profiles')
            .select('user_id')
            .eq('user_id', userId)
            .maybeSingle();

        const isDriver = !!driverProfile;

        if (isDriver) {
            const { data: wallet } = await supabaseAdmin
                .from('driver_wallets')
                .select('*')
                .eq('driver_id', userId)
                .single();

            const newBalance =
                Number(wallet?.balance ?? 0) + totalDeduction;
            const cashDebt = Number(wallet?.cash_debt ?? 0);

            await supabaseAdmin
                .from('driver_wallets')
                .update({ balance: newBalance })
                .eq('driver_id', userId);

            await supabaseAdmin.from('driver_wallet_ledger').insert({
                driver_id: userId,
                entry_type: 'adjustment',
                amount: totalDeduction,
                direction: 'in',
                balance_after: newBalance,
                cash_debt_after: cashDebt,
                description:
                    `Refund withdraw gagal #${wd.inquiry_reff} ` +
                    `(nominal Rp${nominal.toLocaleString(
                        'id-ID'
                    )} + fee Rp${feeAdmin.toLocaleString('id-ID')})`,
                metadata: {
                    inquiry_reff: wd.inquiry_reff,
                    nominal,
                    fee_admin: feeAdmin,
                    total_refund: totalDeduction,
                },
            });
        } else {
            const { data: wallet } = await supabaseAdmin
                .from('wallets')
                .select('*')
                .eq('user_id', userId)
                .single();

            const newBalance =
                Number(wallet?.balance ?? 0) + totalDeduction;

            await supabaseAdmin
                .from('wallets')
                .update({ balance: newBalance })
                .eq('user_id', userId);

            await supabaseAdmin.from('wallet_transactions').insert({
                user_id: userId,
                type: 'withdraw_refund',
                amount: totalDeduction,
                balance_after: newBalance,
                reference_id: wd.inquiry_reff,
                description:
                    `Refund withdraw gagal ` +
                    `(nominal Rp${nominal.toLocaleString(
                        'id-ID'
                    )} + fee Rp${feeAdmin.toLocaleString('id-ID')})`,
            });
        }

        await supabaseAdmin
            .from('wallet_withdrawals')
            .update({
                status: 'FAILED',
                notified_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq('id', wd.id);

        await notificationService.sendToUser(userId, {
            title: 'Penarikan Gagal',
            body:
                `Penarikan Rp${nominal.toLocaleString('id-ID')} gagal. ` +
                `Saldo Rp${totalDeduction.toLocaleString(
                    'id-ID'
                )} sudah dikembalikan.`,
            data: {
                type: 'withdraw_failed',
                amount: nominal,
                fee_admin: feeAdmin,
                total_refund: totalDeduction,
                inquiry_reff: wd.inquiry_reff,
            },
        });

        logger.info('❌ Withdraw FAILED + refund total', {
            inquiry_reff: wd.inquiry_reff,
            userId,
            nominal,
            feeAdmin,
            totalRefund: totalDeduction,
        });
    }
}

// ============================================================
// ✅ HANDLER: ORDER PAYMENT CALLBACK (QRIS / VA)
// ============================================================
// src/modules/wallet/wallet.callback.ts

async function handleOrderPaymentCallback(payment: any, status: string) {
    const isSuccess = ['SUCCESS', 'SETTLED', 'PAID'].includes(status);
    const isFailed = ['FAILED', 'EXPIRED', 'REJECTED'].includes(status);

    // ═══════════════════════════════════════════════════════════
    // IDEMPOTENCY
    // ═══════════════════════════════════════════════════════════
    if (payment.status === 'SUCCESS') {
        logger.info('ℹ️ Order payment sudah SUCCESS, skip', {
            partner_reff: payment.partner_reff,
            orderId: payment.order_id,
        });
        return;
    }

    if (payment.status === 'FAILED' || payment.status === 'EXPIRED') {
        logger.info(
            'ℹ️ Order payment sudah final (FAILED/EXPIRED), skip',
            {
                partner_reff: payment.partner_reff,
                status: payment.status,
            }
        );
        return;
    }

    // ═══════════════════════════════════════════════════════════
    // HANDLE SUCCESS — Customer sudah bayar
    // ═══════════════════════════════════════════════════════════
    if (isSuccess) {
        // 1. Update order_payments
        await supabaseAdmin
            .from('order_payments')
            .update({
                status: 'SUCCESS',
                paid_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq('id', payment.id);

        // 2. Update orders
        await supabaseAdmin
            .from('orders')
            .update({
                payment_status: 'paid',
                paid_at: new Date().toISOString(),
            })
            .eq('id', payment.order_id);

        // 3. Notif ke customer
        await notificationService.sendToUser(payment.user_id, {
            title: 'Pembayaran Berhasil ✅',
            body: `Pembayaran Rp${Number(payment.amount).toLocaleString(
                'id-ID'
            )} untuk order #${payment.order_id} berhasil. Kami sedang mencarikan driver untukmu.`,
            data: {
                type: 'order_payment_success',
                order_id: payment.order_id,
                amount: Number(payment.amount),
                method: payment.method,
                partner_reff: payment.partner_reff,
            },
        });

        // ═══════════════════════════════════════════════════════
        // 4. ✅ TRIGGER MATCHING DRIVER — setelah payment paid
        // ═══════════════════════════════════════════════════════
        try {
            const { orderService } = await import(
                '../order/order.service'
            );

            await orderService.triggerMatchingAfterPayment(
                payment.order_id
            );

            logger.info(
                '🚀 [orderPaymentCallback] Matching driver triggered',
                {
                    orderId: payment.order_id,
                    partner_reff: payment.partner_reff,
                }
            );
        } catch (err: any) {
            logger.error(
                '❌ [orderPaymentCallback] Gagal trigger matching',
                {
                    orderId: payment.order_id,
                    error: err.message,
                }
            );
            // Tidak throw — payment sudah tercatat paid
        }

        logger.info('✅ Order payment SUCCESS', {
            orderId: payment.order_id,
            partner_reff: payment.partner_reff,
            amount: payment.amount,
            method: payment.method,
        });
        return;
    }

    // ═══════════════════════════════════════════════════════════
    // HANDLE FAILED — Customer tidak bayar / expired
    // ═══════════════════════════════════════════════════════════
    if (isFailed) {
        // 1. Update order_payments
        await supabaseAdmin
            .from('order_payments')
            .update({
                status: 'FAILED',
                updated_at: new Date().toISOString(),
            })
            .eq('id', payment.id);

        // 2. Update orders — payment_status failed, order tetap pending
        //    (customer bisa coba bayar lagi atau cancel)
        await supabaseAdmin
            .from('orders')
            .update({
                payment_status: 'failed',
            })
            .eq('id', payment.order_id);

        // 3. Notif ke customer
        await notificationService.sendToUser(payment.user_id, {
            title: 'Pembayaran Gagal',
            body: `Pembayaran untuk order #${payment.order_id} gagal atau kadaluarsa. Silakan coba lagi atau pilih metode lain.`,
            data: {
                type: 'order_payment_failed',
                order_id: payment.order_id,
                amount: Number(payment.amount),
                method: payment.method,
                partner_reff: payment.partner_reff,
            },
        });

        logger.info('❌ Order payment FAILED', {
            orderId: payment.order_id,
            partner_reff: payment.partner_reff,
            status,
        });
        return;
    }

    // ═══════════════════════════════════════════════════════════
    // Status lain — log aja
    // ═══════════════════════════════════════════════════════════
    logger.info('ℹ️ Order payment status lain', {
        partner_reff: payment.partner_reff,
        status,
    });
}

export default router;