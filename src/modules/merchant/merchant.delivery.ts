// src/modules/merchant/merchant.delivery.ts
// Menghitung jarak rute, ongkir, dan ETA untuk daftar merchant.
//
// Alur:
//  1) Jarak rute: Google Distance Matrix (1 request untuk semua merchant).
//     Kalau API key tidak ada / gagal -> estimasi: garis lurus x 1.3, kecepatan 25 km/jam.
//  2) Ongkir: dari tabel `tariffs` (service_type = 'food'): min_fare s.d. base_km,
//     lalu per_km untuk tiap km berikutnya, dibulatkan ke atas per Rp500.
//  3) ETA = waktu persiapan toko + waktu driver ke toko + waktu tempuh.
//  Hasil dicache 10 menit per (area pengguna, merchant) supaya biaya API terkendali.
import { supabaseAdmin } from '../../config/supabase';
import { logger } from '../../config/logger';

// ---------- Konfigurasi (silakan atur) ----------
const ROAD_FACTOR = 1.3;          // jarak jalan ~ 1.3x garis lurus (dipakai kalau tanpa Google)
const AVG_SPEED_KMH = 25;         // kecepatan rata-rata motor dalam kota
const PICKUP_MIN = 5;             // waktu driver menuju toko
const DEFAULT_PREP_MIN = 15;      // waktu persiapan kalau toko belum mengisi prep_time_min
const CACHE_TTL_MS = 10 * 60 * 1000;
const TARIFF_TTL_MS = 5 * 60 * 1000;
const FALLBACK_TARIFF = { min_fare: 8000, per_km: 2500, base_km: 3 };
const FEE_ROUND_TO = 500;

type MerchantLike = {
    user_id: string;
    latitude: number;
    longitude: number;
    prep_time_min?: number | null;
    [k: string]: any;
};

type Route = { distance_m: number; duration_s: number; source: 'google' | 'estimate' };

// ---------- Jarak garis lurus ----------
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number) {
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------- Tarif ----------
let tariffCache: { exp: number; value: { min_fare: number; per_km: number; base_km: number } } | null = null;

async function getFoodTariff() {
    if (tariffCache && tariffCache.exp > Date.now()) return tariffCache.value;

    const { data, error } = await supabaseAdmin
        .from('tariffs')
        .select('min_fare, per_km, base_km')
        .eq('service_type', 'food')
        .eq('is_active', true)
        .order('sort_order', { ascending: true })
        .limit(1)
        .maybeSingle();

    if (error) logger.warn('getFoodTariff error, pakai tarif cadangan', { error: error.message });

    const value = data
        ? {
            min_fare: Number(data.min_fare),
            per_km: Number(data.per_km),
            base_km: Number(data.base_km),
        }
        : FALLBACK_TARIFF;

    tariffCache = { exp: Date.now() + TARIFF_TTL_MS, value };
    return value;
}

function calcFee(routeM: number, t: { min_fare: number; per_km: number; base_km: number }) {
    const km = routeM / 1000;
    const extraKm = Math.max(0, Math.ceil(km - t.base_km));
    const raw = t.min_fare + extraKm * t.per_km;
    return Math.ceil(raw / FEE_ROUND_TO) * FEE_ROUND_TO;
}

// ---------- Rute ----------
const routeCache = new Map<string, Route & { exp: number }>();

function estimateRoute(straightM: number): Route {
    const distance_m = straightM * ROAD_FACTOR;
    const duration_s = (distance_m / 1000 / AVG_SPEED_KMH) * 3600;
    return { distance_m, duration_s, source: 'estimate' };
}

async function googleMatrix(
    lat: number,
    lng: number,
    list: MerchantLike[]
): Promise<Map<string, Route> | null> {
    const key = process.env.GOOGLE_MAPS_API_KEY; // key SERVER, aktifkan Distance Matrix API
    if (!key || list.length === 0) return null;

    const dests = list.map((m) => `${m.latitude},${m.longitude}`).join('|');
    const url =
        `https://maps.googleapis.com/maps/api/distancematrix/json` +
        `?origins=${lat},${lng}&destinations=${encodeURIComponent(dests)}` +
        `&mode=driving&language=id&key=${key}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        const json: any = await res.json();
        if (json.status !== 'OK') {
            logger.warn('Distance Matrix status bukan OK', { status: json.status, msg: json.error_message });
            return null;
        }
        const out = new Map<string, Route>();
        const elements = json.rows?.[0]?.elements ?? [];
        list.forEach((m, i) => {
            const el = elements[i];
            if (el?.status === 'OK') {
                out.set(m.user_id, {
                    distance_m: el.distance.value,
                    duration_s: el.duration.value,
                    source: 'google',
                });
            }
        });
        return out;
    } catch (e: any) {
        logger.warn('Distance Matrix gagal, pakai estimasi', { error: e?.message });
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// ---------- Fungsi utama ----------
export async function enrichWithDelivery<T extends MerchantLike>(
    userLat: number,
    userLng: number,
    merchants: T[]
) {
    if (merchants.length === 0) return [];

    const areaKey = `${userLat.toFixed(3)},${userLng.toFixed(3)}`; // ~110 m
    const now = Date.now();

    // 1) pisahkan yang sudah ada di cache
    const routes = new Map<string, Route>();
    const misses: T[] = [];
    for (const m of merchants) {
        const hit = routeCache.get(`${areaKey}:${m.user_id}`);
        if (hit && hit.exp > now) routes.set(m.user_id, hit);
        else misses.push(m);
    }

    // 2) hitung yang belum ada (Google, fallback estimasi)
    if (misses.length > 0) {
        const g = await googleMatrix(userLat, userLng, misses);
        for (const m of misses) {
            const straight = haversineM(userLat, userLng, m.latitude, m.longitude);
            const route = g?.get(m.user_id) ?? estimateRoute(straight);
            routes.set(m.user_id, route);
            routeCache.set(`${areaKey}:${m.user_id}`, { ...route, exp: now + CACHE_TTL_MS });
        }
    }

    // 3) ongkir + ETA
    const tariff = await getFoodTariff();
    return merchants.map((m) => {
        const r = routes.get(m.user_id)!;
        const prep = m.prep_time_min ?? DEFAULT_PREP_MIN;
        const eta_min = Math.round(prep + PICKUP_MIN + r.duration_s / 60);
        return {
            ...m,
            route_distance_m: Math.round(r.distance_m),
            delivery_fee: calcFee(r.distance_m, tariff),
            eta_min,
            eta_source: r.source,
        };
    });
}