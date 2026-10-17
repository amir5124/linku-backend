// src/modules/order/matching.service.ts
import { supabaseAdmin } from '../../config/supabase';
import { logger } from '../../config/logger';

// ============================================================
// KONFIGURASI
// ============================================================

/** Radius pencarian driver dari titik jemput (meter). 15 km. */
const MATCH_RADIUS_M = Number(process.env.MATCH_RADIUS_M ?? 15000);

/** Maksimum driver yang ditawari per order. */
const MATCH_LIMIT = 20;

/**
 * Kode tarif bawaan per jenis order, dipakai HANYA kalau aplikasi customer
 * tidak mengirim tariff_code. Tanpa ini, fungsi SQL find_nearby_drivers
 * tidak memfilter layanan dan order sampai ke SEMUA driver online.
 *
 * Makanan hanya punya satu kode, jadi aman diisi bawaan.
 * Ride/send punya varian S dan L, jadi tidak ditebak.
 *
 * Sesuaikan lewat env FOOD_TARIFF_CODE kalau kodenya berbeda
 * (LinkU: 'ufood').
 */
const DEFAULT_TARIFF_BY_TYPE: Record<string, string | undefined> = {
    food: process.env.FOOD_TARIFF_CODE ?? 'ufood',
};

// ============================================================
// TYPE — hasil dari RPC find_nearby_drivers
// ============================================================
/**
 * Jastip memakai kumpulan driver MOTOR yang sama dengan URide.
 * Filter layanan di find_nearby_drivers memakai kode tarif ini (bukan 'jastip'),
 * supaya order jastip sampai ke driver motor. Ubah lewat env JASTIP_MATCH_TARIFF.
 */
const JASTIP_MATCH_TARIFF = process.env.JASTIP_MATCH_TARIFF ?? 'uride_s';

export type NearbyDriverResult = {
    user_id: string;
    distance_m: number;
    vehicle_type: string;
    rating_avg: number | null;
};

export const matchingService = {
    /**
     * Cari driver terdekat untuk order tertentu.
     * Menggunakan RPC `find_nearby_drivers` (PostGIS).
     * Setelah dapat list driver, insert ke tabel `order_bids`.
     *
     * @param orderId     ID order
     * @param lat         Latitude titik pickup
     * @param lng         Longitude titik pickup
     * @param type        Tipe order ('ride' | 'food' | 'send')
     * @param tariffCode  Kode tarif (opsional) — untuk filter service driver
     * @returns           List driver yang eligible (sudah punya bid)
     */
    async findDriversForOrder(
        orderId: number,
        lat: number,
        lng: number,
        type: string,
        tariffCode?: string | null
    ): Promise<NearbyDriverResult[]> {
        const effectiveCode =
            type === 'jastip'
                ? JASTIP_MATCH_TARIFF
                : tariffCode ?? DEFAULT_TARIFF_BY_TYPE[type] ?? null;

        console.log('[matching] === CARI DRIVER ===');
        console.log('[matching] orderId:', orderId, '| pickup:', { lat, lng });
        console.log(
            '[matching] type:',
            type,
            '| tariff_code:',
            tariffCode,
            '| dipakai:',
            effectiveCode,
            '| radius:',
            MATCH_RADIUS_M,
            'm'
        );

        if (!tariffCode && !effectiveCode) {
            logger.warn(
                '[matching] tariff_code kosong, filter layanan tidak aktif (order sampai ke semua driver online)',
                { orderId, type }
            );
        } else if (!tariffCode && effectiveCode) {
            logger.warn('[matching] tariff_code kosong, pakai kode bawaan', {
                orderId,
                type,
                effectiveCode,
            });
        }

        // ═══════════════════════════════════════════════════════════
        // 1. Panggil RPC find_nearby_drivers
        // ═══════════════════════════════════════════════════════════
        const { data: drivers, error } = await supabaseAdmin.rpc(
            'find_nearby_drivers',
            {
                p_lat: lat,
                p_lng: lng,
                p_radius_m: MATCH_RADIUS_M,
                p_limit: MATCH_LIMIT,
                p_tariff_code: effectiveCode,
            }
        );

        if (error) {
            console.error('[matching] RPC error:', error);
            logger.error('find_nearby_drivers gagal', {
                error,
                orderId,
            });
            return [];
        }

        const result = (drivers ?? []) as NearbyDriverResult[];

        console.log('[matching] RPC result:', result.length, 'driver');

        if (result.length === 0) {
            logger.warn('No drivers found', {
                orderId,
                lat,
                lng,
                tariffCode: effectiveCode,
                radiusM: MATCH_RADIUS_M,
            });
            return [];
        }

        // ═══════════════════════════════════════════════════════════
        // 2. Insert ke order_bids
        // ═══════════════════════════════════════════════════════════
        const bids = result.map((d: NearbyDriverResult) => ({
            order_id: orderId,
            driver_id: d.user_id,
            distance_km: d.distance_m / 1000,
            status: 'pending',
        }));

        const { error: bidErr } = await supabaseAdmin
            .from('order_bids')
            .insert(bids);

        if (bidErr) {
            // Tanpa bid, driver tidak bisa menerima order (accept() mewajibkan bid).
            // Jadi jangan kembalikan daftar driver, supaya tidak ada notifikasi
            // yang terkirim untuk order yang tidak bisa diambil.
            console.error('[matching] Gagal insert bids:', bidErr);
            logger.error('Gagal insert bids', {
                error: bidErr,
                orderId,
            });
            return [];
        }

        console.log('[matching] ✅ Berhasil insert', bids.length, 'bid');

        return result;
    },
};