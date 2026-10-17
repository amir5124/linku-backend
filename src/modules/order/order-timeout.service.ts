// src/modules/order/order-timeout.service.ts
import { supabaseAdmin } from '../../config/supabase';
import { logger } from '../../config/logger';
import { notificationService } from '../notification/notification.service';
import { orderService } from './order.service';

// ═══════════════════════════════════════════════════════════════
// KONSTANTA TIMEOUT
// ═══════════════════════════════════════════════════════════════

/** Toko tidak merespons pesanan makanan → 5 menit (dihitung dari merchant_notified_at) */
const MERCHANT_TIMEOUT_MS = 5 * 60 * 1000;

/** Tidak ada driver → 5 menit (dihitung dari toko menerima, atau dari dibuat untuk non-food) */
const PENDING_TIMEOUT_MS = 5 * 60 * 1000;

/** Order QRIS/VA belum dibayar → 15 menit */
const PAYMENT_TIMEOUT_MS = 15 * 60 * 1000;

let intervalRef: ReturnType<typeof setInterval> | null = null;

// ═══════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════
export const orderTimeoutService = {
    // ============================================================
    // 0. TOKO TIDAK MERESPONS — auto-tolak
    // ============================================================
    async rejectUnansweredMerchantOrders() {
        const cutoff = new Date(Date.now() - MERCHANT_TIMEOUT_MS).toISOString();

        const { data: stale, error } = await supabaseAdmin
            .from('orders')
            .select('id, merchant_id')
            .eq('status', 'pending')
            .eq('merchant_status', 'waiting')
            .lt('merchant_notified_at', cutoff);

        if (error) {
            logger.error('[orderTimeout] Gagal cari order menunggu toko', {
                error: error.message,
            });
            return;
        }
        if (!stale || stale.length === 0) return;

        logger.info('[orderTimeout] Auto-tolak order (toko diam)', {
            count: stale.length,
        });

        for (const o of stale) {
            try {
                await orderService.merchantRespond(
                    o.id,
                    o.merchant_id,
                    false,
                    { reason: 'Toko tidak merespons' }
                );
            } catch (err: any) {
                // konflik = toko sempat merespons, abaikan
                logger.info('[orderTimeout] Auto-tolak dilewati', {
                    orderId: o.id,
                    err: err.message,
                });
            }
        }
    },

    // ============================================================
    // 1. TIDAK ADA DRIVER — auto-cancel
    // ============================================================
    // Mencakup: cash, wallet, DAN qris/va yang SUDAH dibayar
    // (versi lama melewatkan qris/va paid sehingga uang bisa tertahan).
    // Untuk food, hitungan mulai dari toko menerima (merchant_responded_at),
    // bukan dari order dibuat. Order yang masih menunggu toko dilewati
    // (ditangani rejectUnansweredMerchantOrders).
    async cancelStalePendingOrders() {
        const cutoffMs = Date.now() - PENDING_TIMEOUT_MS;
        const cutoff = new Date(cutoffMs).toISOString();

        const { data: candidates, error } = await supabaseAdmin
            .from('orders')
            .select(
                'id, customer_id, merchant_id, type, payment_method, payment_status, created_at, merchant_status, merchant_responded_at, total_fare'
            )
            .eq('status', 'pending')
            .is('driver_id', null)
            .or('payment_method.in.(cash,wallet),payment_status.eq.paid')
            .lt('created_at', cutoff);

        if (error) {
            logger.error('[orderTimeout] Gagal cari order stale', {
                error: error.message,
            });
            return;
        }
        if (!candidates || candidates.length === 0) return;

        const stale = candidates.filter((o: any) => {
            if (o.merchant_status === 'waiting') return false;
            const ref = new Date(
                o.merchant_responded_at ?? o.created_at
            ).getTime();
            return ref < cutoffMs;
        });
        if (stale.length === 0) return;

        logger.info('[orderTimeout] Auto-cancel order tanpa driver', {
            count: stale.length,
        });

        for (const order of stale) {
            try {
                const { data: updated, error: updateErr } = await supabaseAdmin
                    .from('orders')
                    .update({
                        status: 'cancelled',
                        cancelled_at: new Date().toISOString(),
                        cancellation_reason: 'Tidak ada driver yang menerima',
                    })
                    .eq('id', order.id)
                    .eq('status', 'pending')
                    .select('id')
                    .maybeSingle();

                if (updateErr) {
                    logger.warn('[orderTimeout] Gagal update order stale', {
                        orderId: order.id,
                        err: updateErr.message,
                    });
                    continue;
                }
                if (!updated) continue; // sudah bukan pending

                // Tandai refund bila sudah dibayar
                orderService.flagRefundIfPaid(order);

                await supabaseAdmin
                    .from('order_bids')
                    .update({
                        status: 'expired',
                        responded_at: new Date().toISOString(),
                    })
                    .eq('order_id', order.id)
                    .eq('status', 'pending');

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
                    .catch(() => { });

                // Kabari toko supaya berhenti menyiapkan pesanan
                if (order.type === 'food' && order.merchant_id) {
                    await notificationService
                        .sendToUser(order.merchant_id, {
                            title: 'Pesanan dibatalkan',
                            body: 'Tidak ada driver yang menerima pesanan ini.',
                            data: {
                                order_id: order.id,
                                type: 'order_cancelled',
                                service: 'food',
                            },
                        })
                        .catch(() => { });
                }

                logger.info('[orderTimeout] Auto-cancelled order tanpa driver', {
                    orderId: order.id,
                    paymentMethod: order.payment_method,
                });
            } catch (err: any) {
                logger.warn('[orderTimeout] Gagal cancel order stale', {
                    orderId: order.id,
                    err: err.message,
                });
            }
        }
    },

    // ============================================================
    // 2. PAYMENT (QRIS/VA) belum dibayar > 15 menit
    // ============================================================
    async cancelStalePaymentOrders() {
        const cutoff = new Date(Date.now() - PAYMENT_TIMEOUT_MS).toISOString();

        const { data: stale, error } = await supabaseAdmin
            .from('orders')
            .select(
                'id, customer_id, type, payment_method, payment_reference, payment_status'
            )
            .eq('status', 'pending')
            .eq('payment_status', 'pending')
            .in('payment_method', ['qris', 'bank_transfer'])
            .lt('created_at', cutoff);

        if (error) {
            logger.error('[orderTimeout] Gagal cari payment stale', {
                error: error.message,
            });
            return;
        }
        if (!stale || stale.length === 0) return;

        logger.info('[orderTimeout] Auto-cancel payment stale', {
            count: stale.length,
        });

        for (const order of stale) {
            try {
                const { data: updated, error: updateErr } = await supabaseAdmin
                    .from('orders')
                    .update({
                        status: 'cancelled',
                        cancelled_at: new Date().toISOString(),
                        cancellation_reason:
                            'Pembayaran tidak diselesaikan dalam 15 menit',
                    })
                    .eq('id', order.id)
                    .eq('status', 'pending')
                    .eq('payment_status', 'pending')
                    .select('id')
                    .maybeSingle();

                if (updateErr) {
                    logger.warn('[orderTimeout] Gagal cancel payment stale', {
                        orderId: order.id,
                        err: updateErr.message,
                    });
                    continue;
                }
                if (!updated) continue;

                await supabaseAdmin
                    .from('order_payments')
                    .update({
                        status: 'EXPIRED',
                        updated_at: new Date().toISOString(),
                    })
                    .eq('order_id', order.id)
                    .eq('status', 'PENDING');

                await supabaseAdmin
                    .from('order_bids')
                    .update({
                        status: 'expired',
                        responded_at: new Date().toISOString(),
                    })
                    .eq('order_id', order.id)
                    .eq('status', 'pending');

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
                    .catch(() => { });

                logger.info('[orderTimeout] Auto-cancelled stale payment order', {
                    orderId: order.id,
                    paymentMethod: order.payment_method,
                    paymentReference: order.payment_reference,
                });
            } catch (err: any) {
                logger.warn('[orderTimeout] Gagal cancel stale payment order', {
                    orderId: order.id,
                    err: err.message,
                });
            }
        }
    },

    // ============================================================
    // START / STOP
    // ============================================================
    start(intervalMs = 60_000) {
        if (intervalRef) {
            logger.warn('Order timeout service sudah jalan, skip start ulang');
            return;
        }

        console.log('[order-timeout] Service started, interval:', intervalMs, 'ms');

        const run = (name: string, fn: () => Promise<void>) =>
            fn().catch((e) =>
                logger.error(`order-timeout cron error (${name})`, {
                    err: e.message,
                })
            );

        intervalRef = setInterval(() => {
            run('merchant', () => this.rejectUnansweredMerchantOrders());
            run('pending', () => this.cancelStalePendingOrders());
            run('payment', () => this.cancelStalePaymentOrders());
        }, intervalMs);

        logger.info('Order timeout service started', { intervalMs });
    },

    stop() {
        if (intervalRef) {
            clearInterval(intervalRef);
            intervalRef = null;
            logger.info('Order timeout service stopped');
        }
    },
};