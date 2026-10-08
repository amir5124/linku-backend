// src/modules/order/order-timeout.service.ts
import { supabaseAdmin } from '../../config/supabase';
import { logger } from '../../config/logger';
import { notificationService } from '../notification/notification.service';

// ═══════════════════════════════════════════════════════════════
// KONSTANTA TIMEOUT
// ═══════════════════════════════════════════════════════════════

/** Order cash/wallet tanpa driver → 5 menit */
const PENDING_TIMEOUT_MS = 5 * 60 * 1000;

/** Order QRIS/VA belum dibayar → 15 menit */
const PAYMENT_TIMEOUT_MS = 15 * 60 * 1000;

let intervalRef: ReturnType<typeof setInterval> | null = null;

// ═══════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════
export const orderTimeoutService = {
    // ============================================================
    // 1. AUTO-CANCEL ORDER PENDING (cash/wallet) — tanpa driver
    // ============================================================
    // ============================================================
    // 1. AUTO-CANCEL ORDER CASH/WALLET — 5 menit tanpa driver
    // ============================================================
    async cancelStalePendingOrders() {
        const cutoff = new Date(
            Date.now() - PENDING_TIMEOUT_MS
        ).toISOString();

        // ✅ Filter BENAR: hanya cash/wallet (payment_status bisa 'pending' atau 'paid')
        //    Cash → payment_status = 'pending' (bayar ke driver)
        //    Wallet → payment_status = 'paid' (potong saldo)
        //    QRIS/VA TIDAK masuk sini (dihandle cancelStalePaymentOrders)
        const { data: stale, error } = await supabaseAdmin
            .from('orders')
            .select('id, customer_id, type, payment_method, payment_status')
            .eq('status', 'pending')
            .in('payment_method', ['cash', 'wallet'])   // ⬅️ INI YANG BENAR
            .lt('created_at', cutoff);

        if (error) {
            logger.error('[orderTimeout] Gagal cari order stale', {
                error: error.message,
            });
            return;
        }

        if (!stale || stale.length === 0) return;

        logger.info('[orderTimeout] Auto-cancel order stale (cash/wallet)', {
            count: stale.length,
        });

        for (const order of stale) {
            try {
                const { data: updated, error: updateErr } =
                    await supabaseAdmin
                        .from('orders')
                        .update({
                            status: 'cancelled',
                            cancelled_at: new Date().toISOString(),
                            cancellation_reason:
                                'Tidak ada driver yang menerima',
                        })
                        .eq('id', order.id)
                        .eq('status', 'pending')
                        .select('id')
                        .maybeSingle();

                if (updateErr) {
                    logger.warn(
                        '[orderTimeout] Gagal update order stale',
                        {
                            orderId: order.id,
                            err: updateErr.message,
                        }
                    );
                    continue;
                }

                if (!updated) {
                    logger.info(
                        '[orderTimeout] Order sudah tidak pending, skip',
                        { orderId: order.id }
                    );
                    continue;
                }

                // Cleanup bid
                await supabaseAdmin
                    .from('order_bids')
                    .update({
                        status: 'expired',
                        responded_at: new Date().toISOString(),
                    })
                    .eq('order_id', order.id)
                    .eq('status', 'pending');

                // Notif ke customer
                await notificationService
                    .sendToUser(order.customer_id, {
                        title: 'Pesanan dibatalkan',
                        body: 'Tidak ada driver yang menerima. Silakan coba lagi.',
                        data: {
                            order_id: order.id,
                            type: 'order_timeout',
                            reason: 'no_driver',
                            service: order.type,
                        },
                    })
                    .catch((e) =>
                        logger.warn(
                            '[orderTimeout] Gagal kirim notif timeout',
                            {
                                orderId: order.id,
                                err: e.message,
                            }
                        )
                    );

                logger.info(
                    '[orderTimeout] Auto-cancelled 1 stale order',
                    {
                        orderId: order.id,
                        paymentMethod: order.payment_method,
                    }
                );
            } catch (err: any) {
                logger.warn('[orderTimeout] Gagal cancel order stale', {
                    orderId: order.id,
                    err: err.message,
                });
            }
        }
    },
    // ============================================================
    // 2. AUTO-CANCEL PAYMENT (QRIS/VA) — belum dibayar > 15 menit
    // ============================================================
    async cancelStalePaymentOrders() {
        const cutoff = new Date(
            Date.now() - PAYMENT_TIMEOUT_MS
        ).toISOString();

        const { data: stale, error } = await supabaseAdmin
            .from('orders')
            .select(
                'id, customer_id, type, payment_method, payment_reference, payment_status'
            )
            .eq('status', 'pending')
            .eq('payment_status', 'pending')                 // ⬅️ belum paid
            .in('payment_method', ['qris', 'bank_transfer']) // ⬅️ hanya QRIS/VA
            .lt('created_at', cutoff);

        if (error) {
            logger.error(
                '[orderTimeout] Gagal cari payment stale',
                { error: error.message }
            );
            return;
        }

        if (!stale || stale.length === 0) return;

        logger.info('[orderTimeout] Auto-cancel payment stale', {
            count: stale.length,
        });

        for (const order of stale) {
            try {
                // Update + select (race-safe) — pastikan masih pending
                const { data: updated, error: updateErr } =
                    await supabaseAdmin
                        .from('orders')
                        .update({
                            status: 'cancelled',
                            cancelled_at: new Date().toISOString(),
                            cancellation_reason:
                                'Pembayaran tidak diselesaikan dalam 15 menit',
                        })
                        .eq('id', order.id)
                        .eq('status', 'pending')
                        .eq('payment_status', 'pending')      // ⬅️ guard
                        .select('id')
                        .maybeSingle();

                if (updateErr) {
                    logger.warn(
                        '[orderTimeout] Gagal cancel payment stale',
                        {
                            orderId: order.id,
                            err: updateErr.message,
                        }
                    );
                    continue;
                }

                if (!updated) {
                    logger.info(
                        '[orderTimeout] Payment sudah paid/tidak pending, skip',
                        { orderId: order.id }
                    );
                    continue;
                }

                // Update order_payments → EXPIRED
                await supabaseAdmin
                    .from('order_payments')
                    .update({
                        status: 'EXPIRED',
                        updated_at: new Date().toISOString(),
                    })
                    .eq('order_id', order.id)
                    .eq('status', 'PENDING');

                // Cleanup bid (kalau ada)
                await supabaseAdmin
                    .from('order_bids')
                    .update({
                        status: 'expired',
                        responded_at: new Date().toISOString(),
                    })
                    .eq('order_id', order.id)
                    .eq('status', 'pending');

                // Notif ke customer
                await notificationService
                    .sendToUser(order.customer_id, {
                        title: 'Pesanan dibatalkan',
                        body: 'Pembayaran tidak diselesaikan dalam 15 menit. Silakan order ulang.',
                        data: {
                            order_id: order.id,
                            type: 'order_timeout',
                            reason: 'payment_timeout',
                            service: order.type,
                        },
                    })
                    .catch((e) =>
                        logger.warn(
                            '[orderTimeout] Gagal kirim notif payment timeout',
                            {
                                orderId: order.id,
                                err: e.message,
                            }
                        )
                    );

                logger.info(
                    '[orderTimeout] Auto-cancelled stale payment order',
                    {
                        orderId: order.id,
                        paymentMethod: order.payment_method,
                        paymentReference: order.payment_reference,
                    }
                );
            } catch (err: any) {
                logger.warn(
                    '[orderTimeout] Gagal cancel stale payment order',
                    {
                        orderId: order.id,
                        err: err.message,
                    }
                );
            }
        }
    },

    // ============================================================
    // START — Jalankan interval
    // ============================================================
    start(intervalMs = 60_000) {
        // Cegah double-start
        if (intervalRef) {
            logger.warn(
                'Order timeout service sudah jalan, skip start ulang'
            );
            return;
        }

        console.log(
            '[order-timeout] Service started, interval:',
            intervalMs,
            'ms'
        );

        intervalRef = setInterval(() => {
            // 1. Cancel order pending tanpa driver (cash/wallet)
            this.cancelStalePendingOrders().catch((e) =>
                logger.error('order-timeout cron error (pending)', {
                    err: e.message,
                })
            );

            // 2. Cancel order QRIS/VA belum dibayar
            this.cancelStalePaymentOrders().catch((e) =>
                logger.error('order-timeout cron error (payment)', {
                    err: e.message,
                })
            );
        }, intervalMs);

        logger.info('Order timeout service started', { intervalMs });
    },

    // ============================================================
    // STOP — Graceful shutdown
    // ============================================================
    stop() {
        if (intervalRef) {
            clearInterval(intervalRef);
            intervalRef = null;
            logger.info('Order timeout service stopped');
        }
    },
};