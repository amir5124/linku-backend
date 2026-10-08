// src/modules/order/autobid.service.ts
import { supabaseAdmin } from '../../config/supabase';
import { logger } from '../../config/logger';

export const autobidService = {
    /**
     * Cek apakah driver eligible untuk autobid order tertentu
     */
    async isEligible(
        driverId: string,
        order: {
            id: number;
            type: string;
            driver_earning: number;
            distance_km: number | null;
        }
    ): Promise<{ eligible: boolean; reason?: string }> {
        // ═══════════════════════════════════════════════════════════
        // 1. Ambil config autobid driver
        // ═══════════════════════════════════════════════════════════
        const { data: config } = await supabaseAdmin
            .from('driver_autobid')
            .select('*')
            .eq('driver_id', driverId)
            .maybeSingle();

        if (!config) {
            return { eligible: false, reason: 'no_config' };
        }

        if (!config.is_enabled) {
            return { eligible: false, reason: 'disabled' };
        }

        // ═══════════════════════════════════════════════════════════
        // 2. Cek driver online + verified
        // ═══════════════════════════════════════════════════════════
        const { data: dp } = await supabaseAdmin
            .from('driver_profiles')
            .select('status, is_verified')
            .eq('user_id', driverId)
            .maybeSingle();

        if (dp?.status !== 'online') {
            return { eligible: false, reason: 'not_online' };
        }

        if (!dp?.is_verified) {
            return { eligible: false, reason: 'not_verified' };
        }

        // ═══════════════════════════════════════════════════════════
        // 3. Cek jam aktif (WIB) — ✅ FIX TIMEZONE
        // ═══════════════════════════════════════════════════════════
        // Pakai Intl.DateTimeFormat dengan timezone Asia/Jakarta
        // supaya dapat waktu WIB yang benar (bukan UTC+7 yang salah)
        const wibTime = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Jakarta',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        }).format(new Date());

        const startTime = config.active_hours_start ?? '00:00:00';
        const endTime = config.active_hours_end ?? '23:59:59';

        // Handle lintas tengah malam (mis. 22:00 → 06:00)
        const isOvernight = startTime > endTime;

        const inHours = isOvernight
            ? wibTime >= startTime || wibTime <= endTime
            : wibTime >= startTime && wibTime <= endTime;

        if (!inHours) {
            logger.info('[autobid] Skip: di luar jam aktif', {
                driverId,
                orderId: order.id,
                wibTime,
                startTime,
                endTime,
            });
            return { eligible: false, reason: 'outside_hours' };
        }

        // ═══════════════════════════════════════════════════════════
        // 4. Cek jenis layanan
        // ═══════════════════════════════════════════════════════════
        if (
            config.services &&
            config.services.length > 0 &&
            !config.services.includes(order.type)
        ) {
            return { eligible: false, reason: 'service_not_match' };
        }

        // ═══════════════════════════════════════════════════════════
        // 5. Cek fare minimum
        // ═══════════════════════════════════════════════════════════
        if (order.driver_earning < config.min_fare) {
            return { eligible: false, reason: 'fare_too_low' };
        }

        // ═══════════════════════════════════════════════════════════
        // 6. Cek radius — ⚠️ SKIP DULU
        // ═══════════════════════════════════════════════════════════
        // CATATAN: order.distance_km = jarak pickup→dropoff,
        // BUKAN jarak driver→pickup. Jadi jangan dipakai untuk cek radius.
        //
        // TODO: Nanti kalau matchingService sudah kirim jarak driver→pickup,
        // aktifkan lagi dengan data yang benar:
        //
        // if (
        //     driverDistanceKm != null &&
        //     driverDistanceKm > config.max_radius_km
        // ) {
        //     return { eligible: false, reason: 'too_far' };
        // }

        // ═══════════════════════════════════════════════════════════
        // 7. Cek max order per jam
        // ═══════════════════════════════════════════════════════════
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const { count: recentCount } = await supabaseAdmin
            .from('driver_autobid_log')
            .select('*', { count: 'exact', head: true })
            .eq('driver_id', driverId)
            .eq('status', 'accepted')
            .gte('created_at', oneHourAgo);

        if ((recentCount ?? 0) >= (config.max_orders_per_hour ?? 3)) {
            return { eligible: false, reason: 'rate_limit' };
        }

        return { eligible: true };
    },

    /**
     * Coba autobid order ke list driver.
     * Return: driverId yang berhasil autobid, atau null.
     */
    async tryAutoBid(
        orderId: number,
        order: {
            type: string;
            driver_earning: number;
            distance_km: number | null;
        },
        candidateDriverIds: string[]
    ): Promise<string | null> {
        logger.info('[autobid] Coba autobid', {
            orderId,
            candidates: candidateDriverIds.length,
            orderType: order.type,
            driverEarning: order.driver_earning,
            distanceKm: order.distance_km,
        });

        if (!candidateDriverIds || candidateDriverIds.length === 0) {
            logger.info('[autobid] Skip: tidak ada kandidat driver', {
                orderId,
            });
            return null;
        }

        for (const driverId of candidateDriverIds) {
            // ── Cek eligibility ──
            const { eligible, reason } = await this.isEligible(driverId, {
                id: orderId,
                ...order,
            });

            // ── Log skip ──
            if (!eligible) {
                logger.info('[autobid] Driver tidak eligible', {
                    orderId,
                    driverId,
                    reason,
                });

                await supabaseAdmin.from('driver_autobid_log').insert({
                    driver_id: driverId,
                    order_id: orderId,
                    status: 'skipped',
                    reason: reason ?? 'unknown',
                    distance_km: order.distance_km,
                    fare: order.driver_earning,
                });
                continue;
            }

            // ═══════════════════════════════════════════════════════
            // ✅ ELIGIBLE — Coba accept order (race-safe)
            // ═══════════════════════════════════════════════════════
            const { data: updated, error } = await supabaseAdmin
                .from('orders')
                .update({
                    driver_id: driverId,
                    status: 'accepted',
                    accepted_at: new Date().toISOString(),
                    is_autobid: true,
                })
                .eq('id', orderId)
                .eq('status', 'pending')       // ⬅️ cegah race: harus masih pending
                .is('driver_id', null)          // ⬅️ pastikan belum diambil
                .select('id')
                .maybeSingle();

            if (error || !updated) {
                logger.warn('[autobid] Race — order sudah diambil driver lain', {
                    orderId,
                    driverId,
                    error: error?.message,
                });
                return null;  // stop, order sudah bukan pending
            }

            // ── Log autobid accepted ──
            await supabaseAdmin.from('driver_autobid_log').insert({
                driver_id: driverId,
                order_id: orderId,
                status: 'accepted',
                distance_km: order.distance_km,
                fare: order.driver_earning,
            });

            // ── Increment counter (via RPC — atomic) ──
            try {
                await supabaseAdmin.rpc('increment_autobid_count', {
                    p_driver_id: driverId,
                });
            } catch (err: any) {
                logger.warn('[autobid] Gagal increment counter', {
                    driverId,
                    error: err?.message,
                });
            }

            // ── Update bid driver ini → accepted ──
            await supabaseAdmin
                .from('order_bids')
                .update({
                    status: 'accepted',
                    responded_at: new Date().toISOString(),
                })
                .eq('order_id', orderId)
                .eq('driver_id', driverId);

            // ── Reject bid driver lain ──
            await supabaseAdmin
                .from('order_bids')
                .update({
                    status: 'rejected',
                    responded_at: new Date().toISOString(),
                })
                .eq('order_id', orderId)
                .neq('driver_id', driverId)
                .eq('status', 'pending');

            // ── Set driver busy ──
            await supabaseAdmin
                .from('driver_profiles')
                .update({ status: 'busy' })
                .eq('user_id', driverId);

            logger.info('✅ [autobid] Order auto-accepted', {
                orderId,
                driverId,
            });

            return driverId;
        }

        logger.info('[autobid] Tidak ada driver eligible', {
            orderId,
            totalCandidates: candidateDriverIds.length,
        });
        return null;
    },
};