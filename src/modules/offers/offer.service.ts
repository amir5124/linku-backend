// src/modules/offers/offer.service.ts
import { supabaseAdmin as supabase } from "@/config/supabase"; // SESUAIKAN: client Supabase service-role

export class OfferError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

const NEGO_TYPES = ['ride']; // rilis 1: ojek & mobil saja

async function readSettings(keys: string[]): Promise<Record<string, any>> {
    const { data } = await supabase.from('app_settings').select('key,value').in('key', keys);
    const out: Record<string, any> = {};
    (data ?? []).forEach((r: any) => (out[r.key] = r.value));
    return out;
}

export async function getNegoConfig() {
    const s = await readSettings([
        'nego_enabled', 'nego_max_percent', 'nego_step',
        'nego_offer_ttl_sec', 'nego_max_offers_per_order',
    ]);
    return {
        enabled: String(s.nego_enabled ?? 'true') === 'true',
        maxPercent: Number(s.nego_max_percent ?? 30),
        step: Number(s.nego_step ?? 1000),
        ttlSec: Number(s.nego_offer_ttl_sec ?? 30),
        maxActive: Number(s.nego_max_offers_per_order ?? 5),
    };
}

async function expireStale(orderId: number) {
    const now = new Date().toISOString();
    await supabase
        .from('order_offers')
        .update({ status: 'expired', responded_at: now })
        .eq('order_id', orderId)
        .eq('status', 'pending')
        .lte('expires_at', now);
}

async function assertDriverEligible(driverId: string, tariffCode: string | null) {
    const { data: dp } = await supabase
        .from('driver_profiles')
        .select('status,is_verified,services,total_trips')
        .eq('user_id', driverId)
        .maybeSingle();

    if (!dp || !dp.is_verified) throw new OfferError(403, 'Akun driver belum terverifikasi.');
    if (dp.status !== 'online') throw new OfferError(403, 'Kamu harus online untuk menawar.');
    if (tariffCode && Array.isArray(dp.services) && !dp.services.includes(tariffCode)) {
        throw new OfferError(403, 'Layananmu tidak mencakup order ini.');
    }

    // Aturan kuota gratis & saldo minimal yang sama dengan terima order biasa
    const s = await readSettings(['driver_free_orders', 'driver_min_balance']);
    const free = Number(s.driver_free_orders ?? 5);
    const min = Number(s.driver_min_balance ?? 10000);
    if (min > 0 && Number(dp.total_trips ?? 0) >= free) {
        const { data: w } = await supabase
            .from('driver_wallets').select('balance').eq('driver_id', driverId).maybeSingle();
        if (Number(w?.balance ?? 0) < min) {
            throw new OfferError(403, 'Saldo belum cukup untuk menerima order tunai.');
        }
    }
}

// ---------- DRIVER: kirim penawaran ----------
export async function createOffer(driverId: string, orderId: number, increase: number) {
    const cfg = await getNegoConfig();
    if (!cfg.enabled) throw new OfferError(403, 'Fitur nego sedang dimatikan.');

    const { data: order } = await supabase
        .from('orders')
        .select('id,type,status,payment_method,total_fare,driver_id,customer_id,tariff_code')
        .eq('id', orderId)
        .maybeSingle();

    if (!order) throw new OfferError(404, 'Order tidak ditemukan.');
    if (!NEGO_TYPES.includes(order.type)) throw new OfferError(400, 'Layanan ini belum mendukung nego.');
    if (order.status !== 'pending' || order.driver_id) {
        throw new OfferError(409, 'Order sudah diambil atau dibatalkan.');
    }
    if (order.payment_method !== 'cash') throw new OfferError(400, 'Nego hanya untuk pembayaran tunai.');

    await assertDriverEligible(driverId, order.tariff_code ?? null);

    const base = Number(order.total_fare);
    const inc = Math.round(Number(increase));
    if (!Number.isFinite(inc) || inc <= 0) throw new OfferError(400, 'Kenaikan harga tidak valid.');
    if (inc % cfg.step !== 0) throw new OfferError(400, `Kenaikan harus kelipatan Rp${cfg.step}.`);
    const maxInc = Math.floor((base * cfg.maxPercent) / 100 / cfg.step) * cfg.step;
    if (inc > maxInc) throw new OfferError(400, `Kenaikan maksimal Rp${maxInc}.`);
    const offered = base + inc;

    await expireStale(orderId);
    const { count } = await supabase
        .from('order_offers')
        .select('id', { count: 'exact', head: true })
        .eq('order_id', orderId)
        .eq('status', 'pending');
    if ((count ?? 0) >= cfg.maxActive) throw new OfferError(409, 'Order ini sudah banyak penawaran.');

    const { data: existing } = await supabase
        .from('order_offers').select('id,status')
        .eq('order_id', orderId).eq('driver_id', driverId).maybeSingle();

    const expiresAt = new Date(Date.now() + cfg.ttlSec * 1000).toISOString();
    const fields = {
        base_fare: base, offered_fare: offered, status: 'pending',
        expires_at: expiresAt, responded_at: null,
    };

    let row: any;
    if (existing) {
        if (existing.status === 'pending') throw new OfferError(409, 'Kamu sudah mengirim penawaran untuk order ini.');
        if (existing.status === 'accepted' || existing.status === 'rejected') {
            throw new OfferError(409, 'Penawaranmu untuk order ini sudah dijawab customer.');
        }
        const { data, error } = await supabase
            .from('order_offers').update(fields).eq('id', existing.id).select().single();
        if (error) throw new OfferError(500, error.message);
        row = data;
    } else {
        const { data, error } = await supabase
            .from('order_offers').insert({ order_id: orderId, driver_id: driverId, ...fields })
            .select().single();
        if (error) throw new OfferError(500, error.message);
        row = data;
    }

    // OPSIONAL: push ke customer "Driver menawar Rp..." (polling 3 dtk sudah cukup untuk rilis 1)
    // await sendPush(order.customer_id, { type: 'order_offer', order_id: orderId, ... });

    return row;
}

// ---------- DRIVER: status penawaranku ----------
export async function myOffer(driverId: string, orderId: number) {
    await expireStale(orderId);
    const [{ data: offer }, { data: order }] = await Promise.all([
        supabase.from('order_offers').select('*').eq('order_id', orderId).eq('driver_id', driverId).maybeSingle(),
        supabase.from('orders').select('status').eq('id', orderId).maybeSingle(),
    ]);
    return { offer: offer ?? null, order_status: order?.status ?? 'cancelled' };
}

export async function withdrawOffer(driverId: string, orderId: number, offerId: number) {
    const { error } = await supabase
        .from('order_offers')
        .update({ status: 'withdrawn', responded_at: new Date().toISOString() })
        .eq('id', offerId).eq('order_id', orderId).eq('driver_id', driverId).eq('status', 'pending');
    if (error) throw new OfferError(500, error.message);
    return null;
}

// ---------- CUSTOMER: daftar penawaran ----------
export async function listOffersForCustomer(customerId: string, orderId: number) {
    const { data: order } = await supabase
        .from('orders').select('id,customer_id,status').eq('id', orderId).maybeSingle();
    if (!order || order.customer_id !== customerId) throw new OfferError(404, 'Order tidak ditemukan.');
    if (order.status !== 'pending') return [];

    await expireStale(orderId);
    const { data: offers } = await supabase
        .from('order_offers')
        .select('id,order_id,driver_id,base_fare,offered_fare,expires_at,created_at')
        .eq('order_id', orderId).eq('status', 'pending')
        .gt('expires_at', new Date().toISOString())
        .order('offered_fare', { ascending: true });
    if (!offers?.length) return [];

    const ids = offers.map((o: any) => o.driver_id);
    const [{ data: profs }, { data: dps }] = await Promise.all([
        supabase.from('profiles').select('id,full_name,avatar_url').in('id', ids),
        supabase.from('driver_profiles')
            .select('user_id,plate_number,vehicle_brand,vehicle_model,vehicle_type,rating_avg,total_trips')
            .in('user_id', ids),
    ]);
    const P = new Map((profs ?? []).map((p: any) => [p.id, p]));
    const D = new Map((dps ?? []).map((d: any) => [d.user_id, d]));

    return offers.map((o: any) => {
        const p: any = P.get(o.driver_id) ?? {};
        const d: any = D.get(o.driver_id) ?? {};
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

// ---------- CUSTOMER: terima / tolak ----------
const RPC_ERRORS: Record<string, [number, string]> = {
    OFFER_NOT_FOUND: [404, 'Penawaran tidak ditemukan.'],
    FORBIDDEN: [403, 'Order ini bukan milikmu.'],
    ORDER_TAKEN: [409, 'Order sudah diambil driver lain.'],
    NOT_CASH: [400, 'Nego hanya untuk pembayaran tunai.'],
    OFFER_EXPIRED: [409, 'Penawaran sudah kedaluwarsa.'],
    FARE_CHANGED: [409, 'Harga order berubah, penawaran tidak berlaku.'],
};

export async function acceptOffer(customerId: string, orderId: number, offerId: number) {
    const { data, error } = await supabase.rpc('accept_order_offer', {
        p_order_id: orderId, p_offer_id: offerId, p_customer_id: customerId,
    });
    if (error) {
        const code = Object.keys(RPC_ERRORS).find((k) => error.message?.includes(k));
        if (code) throw new OfferError(RPC_ERRORS[code][0], RPC_ERRORS[code][1]);
        throw new OfferError(500, error.message);
    }
    await onOfferAccepted(data);
    return data as { order_id: number; driver_id: string; total_fare: number };
}

/**
 * SESUAIKAN: efek samping yang biasanya dilakukan fungsi "accept order" biasa.
 * Salin dari sana, misalnya:
 *  - driver_profiles.status -> 'busy' (kalau accept biasa melakukannya)
 *  - push ke driver "Penawaranmu diterima" & ke customer "Driver ditemukan"
 *  - membuat chat room, emit socket, dst.
 */
async function onOfferAccepted(_result: { order_id: number; driver_id: string; total_fare: number }) {
    // TODO
}

export async function rejectOffer(customerId: string, orderId: number, offerId: number) {
    const { data: order } = await supabase
        .from('orders').select('customer_id').eq('id', orderId).maybeSingle();
    if (!order || order.customer_id !== customerId) throw new OfferError(404, 'Order tidak ditemukan.');
    await supabase
        .from('order_offers')
        .update({ status: 'rejected', responded_at: new Date().toISOString() })
        .eq('id', offerId).eq('order_id', orderId).eq('status', 'pending');
    return null;
}