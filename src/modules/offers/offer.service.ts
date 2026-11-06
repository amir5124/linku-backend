// src/modules/offers/offer.service.ts
import { supabaseAdmin } from '../../config/supabase';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../config/logger';
import { notificationService } from '../notification/notification.service';
import { assertDriverCanAccept } from '../order/driver-eligibility';
import { orderService } from '../order/order.service';

const NEGO_TYPES = ['ride']; // rilis 1: ojek & mobil saja

const rp = (n: number) => `Rp${Number(n).toLocaleString('id-ID')}`;

// ============================================================
// Pengaturan (app_settings), dengan nilai bawaan
// ============================================================
async function readSettings(keys: string[]): Promise<Record<string, any>> {
    const { data } = await supabaseAdmin
        .from('app_settings')
        .select('key, value')
        .in('key', keys);
    const out: Record<string, any> = {};
    (data ?? []).forEach((r: any) => (out[r.key] = r.value));
    return out;
}

const clean = (v: any) => String(v).replace(/"/g, '').trim();
const asNum = (v: any, d: number) => {
    if (v == null) return d;
    const n = Number(clean(v));
    return Number.isFinite(n) && n >= 0 ? n : d;
};
const asBool = (v: any, d: boolean) => (v == null ? d : clean(v).toLowerCase() === 'true');

export async function getNegoConfig() {
    const s = await readSettings([
        'nego_enabled',
        'nego_max_percent',
        'nego_step',
        'nego_offer_ttl_sec',
        'nego_max_offers_per_order',
    ]);
    return {
        enabled: asBool(s.nego_enabled, true),
        maxPercent: asNum(s.nego_max_percent, 30),
        step: Math.max(asNum(s.nego_step, 1000), 1),
        ttlSec: Math.max(asNum(s.nego_offer_ttl_sec, 30), 10),
        maxActive: Math.max(asNum(s.nego_max_offers_per_order, 5), 1),
    };
}

async function expireStale(orderId: number) {
    const now = new Date().toISOString();
    await supabaseAdmin
        .from('order_offers')
        .update({ status: 'expired', responded_at: now })
        .eq('order_id', orderId)
        .eq('status', 'pending')
        .lte('expires_at', now);
}

// ============================================================
// Syarat driver (sama dengan accept() biasa)
// ============================================================
async function assertDriverEligible(driverId: string, orderId: number) {
    // Harus termasuk driver yang diundang matching untuk order ini
    const { data: bid } = await supabaseAdmin
        .from('order_bids')
        .select('id')
        .eq('order_id', orderId)
        .eq('driver_id', driverId)
        .eq('status', 'pending')
        .maybeSingle();
    if (!bid) throw ApiError.forbidden('Kamu tidak diundang untuk order ini');

    const { data: dp } = await supabaseAdmin
        .from('driver_profiles')
        .select('status, is_verified')
        .eq('user_id', driverId)
        .maybeSingle();
    if (!dp) throw ApiError.forbidden('Driver profile tidak ditemukan');
    if (dp.status !== 'online') throw ApiError.badRequest('Kamu harus online untuk menawar');
    if (!dp.is_verified) throw ApiError.forbidden('Akun belum terverifikasi');

    // Kuota gratis habis → wajib saldo minimal (melempar ApiError.forbidden)
    await assertDriverCanAccept(driverId);
}

// ============================================================
// DRIVER: kirim penawaran
// ============================================================
export async function createOffer(driverId: string, orderId: number, increase: number) {
    const cfg = await getNegoConfig();
    if (!cfg.enabled) throw ApiError.forbidden('Fitur nego sedang dimatikan');

    const { data: order } = await supabaseAdmin
        .from('orders')
        .select('id, type, status, payment_method, total_fare, driver_id, customer_id')
        .eq('id', orderId)
        .maybeSingle();

    if (!order) throw ApiError.notFound('Order tidak ditemukan');
    if (!NEGO_TYPES.includes(order.type)) throw ApiError.badRequest('Layanan ini belum mendukung nego');
    if (order.status !== 'pending' || order.driver_id) {
        throw ApiError.conflict('Order sudah diambil atau dibatalkan');
    }
    if (order.payment_method !== 'cash') {
        throw ApiError.badRequest('Nego hanya untuk pembayaran tunai');
    }

    await assertDriverEligible(driverId, orderId);

    const base = Number(order.total_fare);
    const inc = Math.round(Number(increase));
    if (!Number.isFinite(inc) || inc <= 0) throw ApiError.badRequest('Kenaikan harga tidak valid');
    if (inc % cfg.step !== 0) throw ApiError.badRequest(`Kenaikan harus kelipatan ${rp(cfg.step)}`);

    const maxInc = Math.floor((base * cfg.maxPercent) / 100 / cfg.step) * cfg.step;
    if (inc > maxInc) {
        throw ApiError.badRequest(
            maxInc > 0 ? `Kenaikan maksimal ${rp(maxInc)}` : 'Tarif ini tidak bisa dinaikkan'
        );
    }
    const offered = base + inc;

    await expireStale(orderId);

    const { count } = await supabaseAdmin
        .from('order_offers')
        .select('id', { count: 'exact', head: true })
        .eq('order_id', orderId)
        .eq('status', 'pending');
    if ((count ?? 0) >= cfg.maxActive) {
        throw ApiError.conflict('Order ini sudah banyak penawaran');
    }

    const { data: existing } = await supabaseAdmin
        .from('order_offers')
        .select('id, status')
        .eq('order_id', orderId)
        .eq('driver_id', driverId)
        .maybeSingle();

    const expiresAt = new Date(Date.now() + cfg.ttlSec * 1000).toISOString();
    const fields = {
        base_fare: base,
        offered_fare: offered,
        status: 'pending',
        expires_at: expiresAt,
        responded_at: null as string | null,
    };

    let row: any;
    if (existing) {
        if (existing.status === 'pending') {
            throw ApiError.conflict('Kamu sudah mengirim penawaran untuk order ini');
        }
        if (existing.status === 'accepted' || existing.status === 'rejected') {
            throw ApiError.conflict('Penawaranmu untuk order ini sudah dijawab customer');
        }
        // expired / withdrawn → boleh menawar lagi
        const { data, error } = await supabaseAdmin
            .from('order_offers')
            .update(fields)
            .eq('id', existing.id)
            .select()
            .single();
        if (error) throw ApiError.internal(error.message);
        row = data;
    } else {
        const { data, error } = await supabaseAdmin
            .from('order_offers')
            .insert({ order_id: orderId, driver_id: driverId, ...fields })
            .select()
            .single();
        if (error) {
            if ((error as any).code === '23505') {
                throw ApiError.conflict('Kamu sudah mengirim penawaran untuk order ini');
            }
            throw ApiError.internal(error.message);
        }
        row = data;
    }

    logger.info('[offer.create]', { orderId, driverId, base, offered });

    // Push ke customer (polling 3 detik juga sudah cukup, ini hanya pelengkap)
    try {
        const { data: prof } = await supabaseAdmin
            .from('profiles')
            .select('full_name')
            .eq('id', driverId)
            .maybeSingle();
        const first = (prof?.full_name ?? 'Driver').trim().split(/\s+/)[0] || 'Driver';
        await notificationService.sendToUser(order.customer_id, {
            title: 'Driver menawar harga',
            body: `${first} menawar ${rp(offered)} (naik ${rp(inc)} dari tarif).`,
            data: {
                order_id: String(orderId),
                type: 'order_offer',
                service: order.type,
            },
        });
    } catch (err: any) {
        logger.warn('[offer.create] Gagal push ke customer', { orderId, err: err?.message });
    }

    return row;
}

// ============================================================
// DRIVER: status penawaranku
// ============================================================
export async function myOffer(driverId: string, orderId: number) {
    await expireStale(orderId);
    const [{ data: offer }, { data: order }] = await Promise.all([
        supabaseAdmin
            .from('order_offers')
            .select('*')
            .eq('order_id', orderId)
            .eq('driver_id', driverId)
            .maybeSingle(),
        supabaseAdmin.from('orders').select('status, driver_id').eq('id', orderId).maybeSingle(),
    ]);

    // Kalau order sudah diambil driver LAIN, tampilkan sebagai tidak aktif lagi
    const takenByOther = !!order?.driver_id && order.driver_id !== driverId;
    return {
        offer: offer ?? null,
        order_status: takenByOther ? 'taken' : order?.status ?? 'cancelled',
    };
}

export async function withdrawOffer(driverId: string, orderId: number, offerId: number) {
    const { error } = await supabaseAdmin
        .from('order_offers')
        .update({ status: 'withdrawn', responded_at: new Date().toISOString() })
        .eq('id', offerId)
        .eq('order_id', orderId)
        .eq('driver_id', driverId)
        .eq('status', 'pending');
    if (error) throw ApiError.internal(error.message);
    return null;
}

// ============================================================
// CUSTOMER: daftar penawaran aktif
// ============================================================
export async function listOffersForCustomer(customerId: string, orderId: number) {
    const { data: order } = await supabaseAdmin
        .from('orders')
        .select('id, customer_id, status')
        .eq('id', orderId)
        .maybeSingle();
    if (!order || order.customer_id !== customerId) throw ApiError.notFound('Order tidak ditemukan');
    if (order.status !== 'pending') return [];

    await expireStale(orderId);

    const { data: offers } = await supabaseAdmin
        .from('order_offers')
        .select('id, order_id, driver_id, base_fare, offered_fare, expires_at, created_at')
        .eq('order_id', orderId)
        .eq('status', 'pending')
        .gt('expires_at', new Date().toISOString())
        .order('offered_fare', { ascending: true });
    if (!offers || offers.length === 0) return [];

    const ids = offers.map((o: any) => o.driver_id);
    const [{ data: profs }, { data: dps }] = await Promise.all([
        supabaseAdmin.from('profiles').select('id, full_name, avatar_url').in('id', ids),
        supabaseAdmin
            .from('driver_profiles')
            .select('user_id, plate_number, vehicle_brand, vehicle_model, vehicle_type, rating_avg, total_trips')
            .in('user_id', ids),
    ]);
    const P = new Map<string, any>((profs ?? []).map((p: any) => [p.id, p]));
    const D = new Map<string, any>((dps ?? []).map((d: any) => [d.user_id, d]));

    return offers.map((o: any) => {
        const p = P.get(o.driver_id) ?? {};
        const d = D.get(o.driver_id) ?? {};
        return {
            id: o.id,
            order_id: o.order_id,
            base_fare: Number(o.base_fare),
            offered_fare: Number(o.offered_fare),
            expires_at: o.expires_at,
            driver: {
                id: o.driver_id,
                name: p.full_name ?? 'Driver',
                avatar_url: p.avatar_url ?? null,
                plate_number: d.plate_number ?? null,
                vehicle_brand: d.vehicle_brand ?? null,
                vehicle_model: d.vehicle_model ?? null,
                vehicle_type: d.vehicle_type ?? null,
                rating_avg: d.rating_avg ?? null,
                total_trips: d.total_trips ?? 0,
            },
        };
    });
}

// ============================================================
// CUSTOMER: terima / tolak
// ============================================================
const RPC_ERRORS: Record<string, () => ApiError> = {
    OFFER_NOT_FOUND: () => ApiError.notFound('Penawaran tidak ditemukan'),
    FORBIDDEN: () => ApiError.forbidden('Order ini bukan milikmu'),
    ORDER_TAKEN: () => ApiError.conflict('Order sudah diambil driver lain'),
    NOT_RIDE: () => ApiError.badRequest('Layanan ini belum mendukung nego'),
    NOT_CASH: () => ApiError.badRequest('Nego hanya untuk pembayaran tunai'),
    OFFER_EXPIRED: () => ApiError.conflict('Penawaran sudah kedaluwarsa'),
    FARE_CHANGED: () => ApiError.conflict('Harga order berubah, penawaran tidak berlaku'),
};

export async function acceptOffer(customerId: string, orderId: number, offerId: number) {
    const { data, error } = await supabaseAdmin.rpc('accept_order_offer', {
        p_order_id: orderId,
        p_offer_id: offerId,
        p_customer_id: customerId,
    });

    if (error) {
        const code = Object.keys(RPC_ERRORS).find((k) => error.message?.includes(k));
        if (code) throw RPC_ERRORS[code]();
        logger.error('[offer.accept] RPC gagal', { orderId, offerId, error: error.message });
        throw ApiError.internal(error.message);
    }

    const result = data as { order_id: number; driver_id: string; total_fare: number };
    logger.info('[offer.accept] Penawaran diterima customer', { orderId, offerId, ...result });

    await onOfferAccepted(result);
    return result;
}

/**
 * Efek samping yang sama dengan accept() biasa (bids, driver 'busy', notif toko/admin),
 * lewat orderService.afterAccepted. Customer tidak dapat push "driver ditemukan"
 * karena dia sendiri yang baru menerima penawaran.
 */
async function onOfferAccepted(result: { order_id: number; driver_id: string; total_fare: number }) {
    try {
        const { data: order } = await supabaseAdmin
            .from('orders')
            .select('*')
            .eq('id', result.order_id)
            .single();
        if (!order) return;

        await orderService.afterAccepted(order, result.driver_id, { notifyCustomer: false });

        await notificationService
            .sendToUser(result.driver_id, {
                title: 'Tawaranmu diterima ✅',
                body: `Customer menerima harga ${rp(result.total_fare)}. Segera menuju titik jemput.`,
                data: {
                    order_id: String(result.order_id),
                    type: 'offer_accepted',
                    service: order.type,
                },
            })
            .catch(() => { });
    } catch (err: any) {
        // Order sudah berpindah ke 'accepted' di database. Kegagalan efek samping
        // tidak boleh membatalkan hasilnya.
        logger.error('[offer.accept] Efek samping gagal', {
            orderId: result.order_id,
            error: err?.message,
        });
    }
}

export async function rejectOffer(customerId: string, orderId: number, offerId: number) {
    const { data: order } = await supabaseAdmin
        .from('orders')
        .select('customer_id')
        .eq('id', orderId)
        .maybeSingle();
    if (!order || order.customer_id !== customerId) throw ApiError.notFound('Order tidak ditemukan');

    await supabaseAdmin
        .from('order_offers')
        .update({ status: 'rejected', responded_at: new Date().toISOString() })
        .eq('id', offerId)
        .eq('order_id', orderId)
        .eq('status', 'pending');
    return null;
}