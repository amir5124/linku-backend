// src/modules/order/order-admin-notify.ts
// Notifikasi untuk ADMIN atas semua kejadian penting pada order:
// order baru, pembayaran, respons toko, belum ada driver, driver menerima,
// perubahan status, dibatalkan (manual / otomatis), jastip, serta kegagalan
// (refund / settlement / pembuatan order) yang perlu ditindak manual.
//
// Aturan pakai:
//  - Semua fungsi "fire and forget": panggil dengan `void adminOrderNotify.xxx(...)`.
//    Tidak pernah melempar error, jadi tidak mengganggu alur order.
//  - Bergantung pada notificationService.sendToUsers dan role 'admin'
//    (channel `admin-notif-v2` di app admin; lihat CHANNEL_MAP / SOUND_MAP).
//
// Payload `data` yang diterima app admin (dipakai untuk navigasi saat notif
// diklik → app/pesanan/[id].tsx):
//   type        : `admin_<event>`  (mis. admin_new_order)
//   severity    : info | warning | critical
//   order_id    : id order (string)  ← kunci navigasi
//   order_code  : kode order
//   service     : food | send | ride | jastip
//   status      : status order saat notif dikirim (untuk statusChanged = status BARU)
//
// Mematikan sebagian notifikasi tanpa ubah kode (env, pisahkan dengan koma):
//   ADMIN_NOTIFY_MUTE=status_arrived,status_in_progress,driver_assigned
// Nama event: new_order, payment_paid, merchant_response, no_driver,
//   driver_assigned, status_arrived, status_purchasing, status_in_progress,
//   status_completed, status_cancelled, purchase, purchase_no_receipt,
//   auto_cancelled, order_failed, refund_failed, refund_review, settle_failed
import { supabaseAdmin } from '../../config/supabase';
import { logger } from '../../config/logger';
import { notificationService } from '../notification/notification.service';
import { kindOf, type OrderKind } from './order-notification.copy';

// ============================================================
// KONFIGURASI
// ============================================================
const MUTED = new Set(
    (process.env.ADMIN_NOTIFY_MUTE ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
);

const ADMIN_CACHE_MS = 60_000;

type Severity = 'info' | 'warning' | 'critical';
type Copy = { title: string; body: string };
type Built = Copy & {
    severity?: Severity;
    extra?: Record<string, any>;
    /** user id yang tidak perlu dikabari (mis. admin yang sedang mengubah order) */
    exclude?: string;
};
type Parties = {
    customer: string;
    driver: string | null;
    store: string | null;
};

// ============================================================
// HELPER TEKS
// ============================================================
const rp = (n: number | string | null | undefined) =>
    `Rp${Number(n ?? 0).toLocaleString('id-ID')}`;

const clip = (s: string, max = 200) =>
    s.length > max ? `${s.slice(0, max - 1)}…` : s;

const SERVICE: Record<OrderKind, { label: string; emoji: string }> = {
    ride: { label: 'Ride', emoji: '🚗' },
    send: { label: 'Kirim Paket', emoji: '📦' },
    food: { label: 'Makanan', emoji: '🍔' },
    jastip: { label: 'Jastip', emoji: '🛍️' },
};

const PAY_LABEL: Record<string, string> = {
    cash: 'Tunai',
    wallet: 'Saldo',
    qris: 'QRIS',
    bank_transfer: 'Transfer Bank',
};

const PLUS_CODE = /^[A-Z0-9]{4,8}\+[A-Z0-9]+$/i;

function place(name?: string | null): string {
    if (!name) return '-';
    const parts = name
        .split(',')
        .map((s) => s.trim())
        .filter((p) => p && !PLUS_CODE.test(p));
    return clip(parts[0] ?? name, 40);
}

const svc = (order: any) => SERVICE[kindOf(order.type)];
const code = (order: any) => order.order_code ?? `#${order.id}`;
const route = (order: any, p: Parties) =>
    kindOf(order.type) === 'food' && p.store
        ? `${p.store} → ${place(order.dropoff_name)}`
        : `${place(order.pickup_name)} → ${place(order.dropoff_name)}`;

/** Tahap order saat dibatalkan (dari status SEBELUM berubah) */
const STAGE: Record<string, string> = {
    pending: 'saat masih mencari driver',
    accepted: 'setelah driver menerima',
    arrived: 'saat driver sudah tiba',
    purchasing: 'saat driver sedang belanja',
    in_progress: 'saat perjalanan berlangsung',
};

// ============================================================
// DATA PENDUKUNG
// ============================================================
let adminCache: { ids: string[]; at: number } | null = null;

async function getAdminIds(): Promise<string[]> {
    if (adminCache && Date.now() - adminCache.at < ADMIN_CACHE_MS) {
        return adminCache.ids;
    }
    const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('role', 'admin');

    if (error) {
        logger.warn('[admin-notify] Gagal ambil daftar admin', {
            err: error.message,
        });
        return adminCache?.ids ?? [];
    }
    const ids = (data ?? []).map((r: any) => r.id as string);
    adminCache = { ids, at: Date.now() };
    return ids;
}

const ORDER_COLS =
    'id, order_code, type, status, customer_id, driver_id, merchant_id, pickup_name, dropoff_name, total_fare, delivery_fee, subtotal, payment_method, payment_status, cancellation_reason';

/** Lengkapi data order bila pemanggil hanya punya sebagian kolom */
async function hydrate(order: any): Promise<any> {
    if (
        order?.order_code &&
        order?.pickup_name !== undefined &&
        order?.total_fare !== undefined
    ) {
        return order;
    }
    const { data } = await supabaseAdmin
        .from('orders')
        .select(ORDER_COLS)
        .eq('id', order.id)
        .maybeSingle();
    return { ...(data ?? {}), ...order };
}

async function loadParties(order: any): Promise<Parties> {
    const ids = [order.customer_id, order.driver_id].filter(Boolean) as string[];
    const names = new Map<string, string>();

    if (ids.length) {
        const { data } = await supabaseAdmin
            .from('profiles')
            .select('id, full_name')
            .in('id', ids);
        (data ?? []).forEach((r: any) =>
            names.set(r.id, String(r.full_name ?? '').trim())
        );
    }

    let store: string | null = null;
    if (order.merchant_id) {
        const { data: m } = await supabaseAdmin
            .from('merchant_profiles')
            .select('store_name')
            .eq('user_id', order.merchant_id)
            .maybeSingle();
        store = m?.store_name ?? null;
    }

    return {
        customer: clip(names.get(order.customer_id) || 'Customer', 28),
        driver: order.driver_id
            ? clip(names.get(order.driver_id) || 'Driver', 28)
            : null,
        store: store ? clip(store, 28) : null,
    };
}

// ============================================================
// PENGIRIM
// ============================================================
async function emit(
    event: string,
    rawOrder: any,
    build: (order: any, p: Parties) => Built | null
): Promise<void> {
    if (MUTED.has(event)) return;
    if (!rawOrder?.id) return;

    try {
        const order = await hydrate(rawOrder);
        const parties = await loadParties(order);
        const built = build(order, parties);
        if (!built) return;

        const ids = (await getAdminIds()).filter((id) => id !== built.exclude);
        if (!ids.length) {
            logger.warn('[admin-notify] Tidak ada admin, notif dilewati', {
                event,
                orderId: order.id,
            });
            return;
        }

        await notificationService.sendToUsers(ids, {
            title: clip(built.title, 80),
            body: clip(built.body, 220),
            data: {
                type: `admin_${event}`,
                severity: built.severity ?? 'info',
                order_id: String(order.id),
                order_code: order.order_code ?? '',
                service: order.type ?? '',
                status: order.status ?? '',
                // `extra` boleh menimpa field di atas (mis. status BARU)
                ...(built.extra ?? {}),
            },
        });

        logger.info('[admin-notify] Terkirim', {
            event,
            orderId: order.id,
            admins: ids.length,
        });
    } catch (err: any) {
        logger.warn('[admin-notify] Gagal kirim', {
            event,
            orderId: rawOrder?.id,
            err: err?.message,
        });
    }
}

// ============================================================
// COPY PERUBAHAN STATUS
// `o` = data order SEBELUM berubah (supaya tahap pembatalan bisa dibaca).
// ============================================================
function buildStatusCopy(
    o: any,
    p: Parties,
    status: string,
    ctx: { actorId?: string; actorRole?: string; reason?: string | null }
): Built | null {
    const s = svc(o);
    const kind = kindOf(o.type);
    const driver = p.driver ?? 'Driver';
    const exclude = ctx.actorRole === 'admin' ? ctx.actorId : undefined;

    switch (status) {
        case 'arrived': {
            const title =
                kind === 'ride'
                    ? '📍 Driver tiba di titik jemput'
                    : kind === 'send'
                        ? '📍 Driver tiba di lokasi pengirim'
                        : '📍 Driver tiba di toko';
            return {
                title,
                body: `${driver} · ${code(o)} (${s.label}) · ${place(o.pickup_name)}`,
                exclude,
            };
        }
        case 'purchasing':
            return {
                title: '🛒 Driver mulai belanja',
                body: `${driver} berbelanja untuk ${code(o)} di ${place(o.pickup_name)} · pemesan ${p.customer}`,
                exclude,
            };
        case 'in_progress': {
            const title =
                kind === 'ride'
                    ? '🚀 Perjalanan dimulai'
                    : kind === 'send'
                        ? '🚀 Pengantaran paket dimulai'
                        : kind === 'food'
                            ? '🚀 Pesanan sedang diantar'
                            : '🚀 Belanjaan sedang diantar';
            return {
                title,
                body: `${driver} menuju ${place(o.dropoff_name)} · ${code(o)} · ${p.customer}`,
                exclude,
            };
        }
        case 'completed':
            return {
                title: '🎯 Order selesai',
                body: `${code(o)} (${s.label}) selesai · ${driver} → ${p.customer} · ${rp(o.total_fare)}`,
                exclude,
            };
        case 'cancelled': {
            const who =
                ctx.actorRole === 'customer'
                    ? `customer ${p.customer}`
                    : ctx.actorRole === 'driver'
                        ? `driver ${driver}`
                        : ctx.actorRole === 'merchant'
                            ? `toko ${p.store ?? ''}`.trim()
                            : ctx.actorRole === 'admin'
                                ? 'admin'
                                : 'sistem';
            const stage = STAGE[o.status] ? ` ${STAGE[o.status]}` : '';
            return {
                title: '❌ Order dibatalkan',
                body: `${code(o)} (${s.label}) dibatalkan oleh ${who}${stage}. Alasan: ${ctx.reason || '-'}`,
                severity: 'warning',
                exclude,
            };
        }
        default:
            return null;
    }
}

// ============================================================
// API (panggil dengan: void adminOrderNotify.xxx(...))
// ============================================================
export const adminOrderNotify = {
    // ── Order baru masuk (setelah pembayaran ditangani) ──
    newOrder(order: any) {
        return emit('new_order', order, (o, p) => {
            const s = svc(o);
            const method = String(o.payment_method ?? 'cash');
            const bayar =
                method === 'cash'
                    ? 'Tunai'
                    : method === 'wallet'
                        ? 'Saldo (lunas)'
                        : `${PAY_LABEL[method] ?? method} (menunggu pembayaran)`;
            return {
                title: `${s.emoji} Order ${s.label} baru masuk`,
                body: `${code(o)} · ${p.customer} · ${route(o, p)} · ${rp(o.total_fare)} · ${bayar}`,
            };
        });
    },

    // ── QRIS / VA sudah dibayar ──
    paymentPaid(order: any) {
        return emit('payment_paid', order, (o, p) => {
            const s = svc(o);
            const next =
                kindOf(o.type) === 'food' && o.merchant_id
                    ? 'Menunggu konfirmasi toko.'
                    : 'Sedang dicarikan driver.';
            return {
                title: '💳 Pembayaran diterima',
                body: `${code(o)} (${s.label}) · ${p.customer} · ${rp(o.total_fare)} via ${PAY_LABEL[o.payment_method] ?? o.payment_method} lunas. ${next}`,
            };
        });
    },

    // ── Toko menerima / menolak (termasuk auto-tolak karena tidak merespons) ──
    merchantResponded(
        order: any,
        accepted: boolean,
        opts: { prep_minutes?: number; reason?: string } = {}
    ) {
        return emit('merchant_response', order, (o, p) => {
            const store = p.store ?? 'Toko';
            if (accepted) {
                return {
                    title: '🏪 Toko menerima pesanan',
                    body: `${store} menerima ${code(o)}${opts.prep_minutes ? ` · siap ±${opts.prep_minutes} menit` : ''}. Sedang dicarikan driver.`,
                };
            }
            return {
                title: '⚠️ Toko menolak pesanan',
                body: `${store} menolak ${code(o)} dari ${p.customer}${opts.reason ? `. Alasan: ${opts.reason}` : ''}. Pesanan dibatalkan.`,
                severity: 'warning',
            };
        });
    },

    // ── Tidak ada driver yang memenuhi syarat saat dispatch ──
    noDriver(order: any) {
        return emit('no_driver', order, (o, p) => ({
            title: '🚫 Belum ada driver tersedia',
            body: `${code(o)} (${svc(o).label}) dari ${place(o.pickup_name)}: tidak ada driver online yang memenuhi syarat di radius pencarian. ${p.customer} sedang menunggu. Order dibatalkan otomatis jika tetap tanpa driver.`,
            severity: 'warning',
        }));
    },

    // ── Driver menerima (manual / autobid) ──
    driverAssigned(order: any, driverId: string, opts: { autobid?: boolean } = {}) {
        return emit('driver_assigned', { ...order, driver_id: driverId }, (o, p) => ({
            title: '✅ Driver menerima order',
            body: `${p.driver ?? 'Driver'} menerima ${code(o)} (${svc(o).label})${opts.autobid ? ' lewat autobid' : ''} · ${route(o, p)}`,
        }));
    },

    // ── Perubahan status lewat updateStatus ──
    // `order` = data SEBELUM berubah (supaya tahap pembatalan bisa dibaca).
    // Field `status` di payload diisi status BARU lewat `extra`.
    statusChanged(
        order: any,
        status: string,
        ctx: { actorId?: string; actorRole?: string; reason?: string | null } = {}
    ) {
        return emit(`status_${status}`, order, (o, p) => {
            const built = buildStatusCopy(o, p, status, ctx);
            if (!built) return null;
            return { ...built, extra: { status, ...(built.extra ?? {}) } };
        });
    },

    // ── Jastip: driver konfirmasi belanja ──
    purchaseConfirmed(
        order: any,
        d: {
            actualTotal: number;
            budget: number;
            refund: number;
            noReceipt: boolean;
            noReceiptNote?: string;
            isCash: boolean;
        }
    ) {
        const event = d.noReceipt ? 'purchase_no_receipt' : 'purchase';
        return emit(event, order, (o, p) => {
            const driver = p.driver ?? 'Driver';
            if (d.noReceipt) {
                return {
                    title: '⚠️ Jastip tanpa struk',
                    body: `${code(o)} · ${driver} belanja ${rp(d.actualTotal)} tanpa struk. Alasan: ${d.noReceiptNote || '-'}. Mohon periksa foto bukti.`,
                    severity: 'warning',
                };
            }
            const extra = d.isCash
                ? ' · bayar tunai'
                : d.refund > 0
                    ? ` · selisih ${rp(d.refund)} dikembalikan`
                    : '';
            return {
                title: '🧾 Belanja jastip dikonfirmasi',
                body: `${code(o)} · ${driver} belanja ${rp(d.actualTotal)} dari budget ${rp(d.budget)}${extra}`,
            };
        });
    },

    // ── Dibatalkan otomatis oleh sistem (timeout) ──
    autoCancelled(order: any, reason: 'no_driver' | 'payment_timeout') {
        return emit('auto_cancelled', order, (o, p) => ({
            title: '⏱️ Order dibatalkan otomatis',
            body:
                reason === 'no_driver'
                    ? `${code(o)} (${svc(o).label}) · ${p.customer}: tidak ada driver yang menerima dalam batas waktu.`
                    : `${code(o)} (${svc(o).label}) · ${p.customer}: pembayaran tidak diselesaikan dalam 15 menit.`,
            severity: 'warning',
            extra: { reason },
        }));
    },

    // ── Order gagal dibuat (pembayaran wallet / link pembayaran gagal) ──
    orderFailed(order: any, message: string) {
        return emit('order_failed', order, (o, p) => ({
            title: '🚨 Order gagal dibuat',
            body: `${code(o)} (${svc(o).label}) · ${p.customer}: ${message}`,
            severity: 'warning',
        }));
    },

    // ── Refund otomatis gagal → proses manual ──
    refundFailed(order: any, message?: string, opts: { amount?: number } = {}) {
        return emit('refund_failed', order, (o, p) => ({
            title: '🚨 Refund gagal',
            body: `${code(o)} · ${rp(opts.amount ?? o.total_fare)} untuk ${p.customer} (${PAY_LABEL[o.payment_method] ?? o.payment_method}) gagal dikembalikan otomatis${message ? `: ${message}` : ''}. Cek dan proses manual.`,
            severity: 'critical',
        }));
    },

    // ── Dibatalkan setelah driver berjalan → refund perlu ditinjau ──
    refundReview(order: any) {
        return emit('refund_review', order, (o, p) => ({
            title: '🔎 Refund perlu ditinjau',
            body: `${code(o)} dibatalkan ${STAGE[o.status] ?? 'setelah driver berjalan'}. Dana ${rp(o.total_fare)} (${PAY_LABEL[o.payment_method] ?? o.payment_method}) milik ${p.customer} belum dikembalikan otomatis. Mohon tinjau manual.`,
            severity: 'warning',
        }));
    },

    // ── Pembagian pendapatan (settlement) gagal ──
    settleFailed(order: any, message?: string) {
        return emit('settle_failed', order, (o, p) => ({
            title: '🚨 Settlement wallet gagal',
            body: `${code(o)} sudah selesai, tapi pembagian pendapatan untuk ${p.driver ?? 'driver'} gagal${message ? `: ${message}` : ''}. Cek dan proses manual.`,
            severity: 'critical',
        }));
    },
};