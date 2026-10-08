// src/modules/order/matching.service.ts
import { supabaseAdmin } from '../../config/supabase';
import { logger } from '../../config/logger';

// ============================================================
// TYPE — hasil dari RPC find_nearby_drivers
// ============================================================
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
     * @returns           List driver yang eligible
     */
    async findDriversForOrder(
        orderId: number,
        lat: number,
        lng: number,
        type: string,
        tariffCode?: string | null
    ): Promise<NearbyDriverResult[]> {
        console.log('[matching] === CARI DRIVER ===');
        console.log('[matching] orderId:', orderId, '| pickup:', { lat, lng });
        console.log('[matching] type:', type, '| tariff_code:', tariffCode);

        // ═══════════════════════════════════════════════════════════
        // 1. Panggil RPC find_nearby_drivers
        // ═══════════════════════════════════════════════════════════
        const { data: drivers, error } = await supabaseAdmin.rpc(
            'find_nearby_drivers',
            {
                p_lat: lat,
                p_lng: lng,
                p_radius_m: 20000,          // 20 km
                p_limit: 20,
                p_tariff_code: tariffCode ?? null,
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
                tariffCode,
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
            console.error('[matching] Gagal insert bids:', bidErr);
            logger.error('Gagal insert bids', {
                error: bidErr,
                orderId,
            });
        } else {
            console.log(
                '[matching] ✅ Berhasil insert',
                bids.length,
                'bid'
            );
        }

        return result;
    },
};