import { supabaseAdmin } from '../../config/supabase';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../config/logger';

// ============================================================
// Location parsers
// ============================================================
function parseEwkbHex(
    hex: string
): { latitude: number; longitude: number } | null {
    if (!hex || typeof hex !== 'string') return null;
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length < 50) return null;

    try {
        const little = hex.slice(0, 2) === '01';
        const lngHex = hex.slice(18, 34);
        const latHex = hex.slice(34, 50);

        const hexToDouble = (h: string) => {
            const bytes = new Uint8Array(8);
            for (let i = 0; i < 8; i++) {
                const idx = little ? i : 7 - i;
                bytes[idx] = parseInt(h.substr(i * 2, 2), 16);
            }
            return new DataView(bytes.buffer).getFloat64(0, true);
        };

        const longitude = hexToDouble(lngHex);
        const latitude = hexToDouble(latHex);

        if (
            Number.isFinite(latitude) &&
            Number.isFinite(longitude) &&
            !(latitude === 0 && longitude === 0)
        ) {
            return { latitude, longitude };
        }
    } catch (err) {
        console.warn('[parseEwkbHex] gagal:', err);
    }
    return null;
}

function parseLocation(
    loc: any
): { latitude: number; longitude: number } | null {
    if (!loc) return null;

    if (typeof loc === 'string') {
        const fromHex = parseEwkbHex(loc);
        if (fromHex) return fromHex;

        const m = loc.match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i);
        if (m) {
            return { latitude: Number(m[2]), longitude: Number(m[1]) };
        }
        return null;
    }

    if (Array.isArray(loc?.coordinates) && loc.coordinates.length >= 2) {
        const [lng, lat] = loc.coordinates;
        if (typeof lat === 'number' && typeof lng === 'number') {
            return { latitude: lat, longitude: lng };
        }
    }

    if (typeof loc.latitude === 'number' && typeof loc.longitude === 'number') {
        return { latitude: loc.latitude, longitude: loc.longitude };
    }

    return null;
}

// ============================================================
// Service
// ============================================================
export const driverService = {
    // ============================================================
    // UPDATE LOCATION
    // ============================================================
    async updateLocation(driverId: string, lat: number, lng: number) {
        const { error } = await supabaseAdmin.rpc('update_driver_location', {
            p_driver_id: driverId,
            p_lat: lat,
            p_lng: lng,
        });

        // Fallback kalau RPC belum dibuat
        if (error) {
            logger.warn('RPC update_driver_location gagal, pakai fallback', {
                error: error.message,
                driverId,
            });

            const { error: fallbackErr } = await supabaseAdmin
                .from('driver_profiles')
                .update({
                    current_location: `POINT(${lng} ${lat})`,
                    location_updated_at: new Date().toISOString(),
                })
                .eq('user_id', driverId);

            if (fallbackErr) {
                logger.error('Fallback update location gagal', {
                    error: fallbackErr,
                    driverId,
                });
                throw ApiError.internal(fallbackErr.message);
            }
        }
    },

    // ============================================================
    // SET STATUS (online/offline/busy)
    // ============================================================
    async setStatus(driverId: string, status: 'offline' | 'online' | 'busy') {
        // 🆕 Kalau mau online, cek is_verified
        if (status === 'online') {
            const { data: dp } = await supabaseAdmin
                .from('driver_profiles')
                .select('is_verified')
                .eq('user_id', driverId)
                .maybeSingle();

            if (!dp) {
                throw ApiError.notFound('Driver profile tidak ditemukan');
            }

            if (!dp.is_verified) {
                logger.warn('[driver.setStatus] Driver belum verified', {
                    driverId,
                });
                throw ApiError.forbidden(
                    'Akun belum terverifikasi. Upload dokumen dulu.'
                );
            }
        }

        // Cek juga kalau masih ada order aktif
        if (status === 'online' || status === 'offline') {
            const { data: activeOrders } = await supabaseAdmin
                .from('orders')
                .select('id, order_code, status, accepted_at, created_at')
                .eq('driver_id', driverId)
                .in('status', ['accepted', 'arrived', 'in_progress']);

            if (activeOrders && activeOrders.length > 0) {
                // 🆕 Auto-cleanup order stuck > 6 jam
                const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
                const now = Date.now();

                const stuckOrders = activeOrders.filter((o) => {
                    const refTime = o.accepted_at
                        ? new Date(o.accepted_at).getTime()
                        : o.created_at
                            ? new Date(o.created_at).getTime()
                            : 0;
                    return refTime && now - refTime > SIX_HOURS_MS;
                });

                if (stuckOrders.length > 0) {
                    logger.warn(
                        '[driver.setStatus] Auto-cancel stuck orders',
                        {
                            driverId,
                            stuckOrderIds: stuckOrders.map((o) => o.id),
                            stuckOrderCodes: stuckOrders.map(
                                (o) => o.order_code
                            ),
                        }
                    );

                    const { error: cancelErr } = await supabaseAdmin
                        .from('orders')
                        .update({
                            status: 'cancelled',
                            cancelled_at: new Date().toISOString(),
                            cancellation_reason:
                                'Auto-cancel: order stuck > 6 jam',
                        })
                        .in(
                            'id',
                            stuckOrders.map((o) => o.id)
                        );

                    if (cancelErr) {
                        logger.error(
                            '[driver.setStatus] Gagal auto-cancel stuck orders',
                            {
                                driverId,
                                error: cancelErr.message,
                            }
                        );
                    } else {
                        logger.info(
                            '[driver.setStatus] ✅ Stuck orders di-cancel',
                            {
                                driverId,
                                count: stuckOrders.length,
                            }
                        );
                    }

                    // Cek sisa order aktif (yang belum stuck)
                    const stuckIds = new Set(
                        stuckOrders.map((o) => o.id)
                    );
                    const remaining = activeOrders.filter(
                        (o) => !stuckIds.has(o.id)
                    );

                    if (remaining.length > 0) {
                        throw ApiError.badRequest(
                            `Selesaikan order aktif dulu: ${remaining
                                .map((o) => o.order_code)
                                .join(', ')}`
                        );
                    }
                    // Kalau semua stuck → lanjut ke update status
                } else {
                    // Ada order aktif, tapi belum stuck
                    throw ApiError.badRequest(
                        'Selesaikan order aktif dulu sebelum ubah status'
                    );
                }
            }
        }

        const { error } = await supabaseAdmin
            .from('driver_profiles')
            .update({ status })
            .eq('user_id', driverId);

        if (error) throw ApiError.internal(error.message);

        logger.info('[driver.setStatus] Status updated', {
            driverId,
            status,
        });
    },
    // ============================================================
    // UPDATE PROFILE
    // ============================================================
    async updateProfile(driverId: string, patch: Record<string, any>) {
        // 🆕 Validasi vehicle_type
        if (patch.vehicle_type !== undefined) {
            if (!['motor', 'mobil'].includes(patch.vehicle_type)) {
                throw ApiError.badRequest(
                    'Tipe kendaraan tidak valid. Hanya "motor" atau "mobil".'
                );
            }
        }

        // 🆕 Validasi tambahan: kalau ganti ke mobil, cek services
        // (motor bisa semua, mobil cuma UCar)
        if (patch.vehicle_type === 'mobil') {
            const { data: current } = await supabaseAdmin
                .from('driver_profiles')
                .select('services')
                .eq('user_id', driverId)
                .maybeSingle();

            if (current?.services) {
                // Cek apakah ada service motor-only yang tidak kompatibel
                const motorOnlyServices = [
                    'uride_s',
                    'uride_l',
                    'usend_s',
                    'usend_l',
                    'ufood',
                ];
                const incompatible = current.services.filter((s: string) =>
                    motorOnlyServices.includes(s)
                );

                if (incompatible.length > 0) {
                    logger.warn('[driver.updateProfile] Ganti ke mobil dengan services motor', {
                        driverId,
                        incompatible,
                    });
                    // Optional: auto-hapus services yang tidak cocok
                    // atau throw error. Di sini kita throw supaya user konfirmasi dulu.
                    throw ApiError.badRequest(
                        `Kamu perlu ubah layanan dulu sebelum ganti ke mobil. ` +
                        `Layanan yang tidak cocok: ${incompatible.join(', ')}. ` +
                        `Buka Edit Layanan dulu.`
                    );
                }
            }
        }

        const { data, error } = await supabaseAdmin
            .from('driver_profiles')
            .update(patch)
            .eq('user_id', driverId)
            .select()
            .single();

        if (error) throw ApiError.internal(error.message);
        return data;
    },

    // ============================================================
    // UPDATE SERVICES
    // ============================================================
    async updateServices(driverId: string, services: string[]) {
        // 1. Validasi tariff code
        const { data: validTariffs } = await supabaseAdmin
            .from('tariffs')
            .select('code')
            .eq('is_active', true);

        const validCodes = new Set(
            (validTariffs ?? []).map((t: any) => t.code)
        );
        const filtered = services.filter((s) => validCodes.has(s));

        if (filtered.length === 0) {
            throw ApiError.badRequest('Pilih minimal 1 layanan valid');
        }

        // 🆕 2. Cek vehicle_type driver
        const { data: driver } = await supabaseAdmin
            .from('driver_profiles')
            .select('vehicle_type')
            .eq('user_id', driverId)
            .maybeSingle();

        if (!driver) {
            throw ApiError.notFound('Driver profile tidak ditemukan');
        }

        // 🆕 3. Mapping service → kendaraan yang cocok
        // (samakan dengan frontend edit-services.tsx)
        const SERVICE_VEHICLE_RULES: Record<string, ('motor' | 'mobil')[]> = {
            uride_s: ['motor'],
            uride_l: ['motor'],
            usend_s: ['motor'],
            usend_l: ['motor'],
            ufood: ['motor'],         // 🆕 motor bisa WarFood
            ucar_s: ['mobil'],
            ucar_l: ['mobil'],
        };

        // 🆕 4. Filter service yang tidak cocok dengan kendaraan
        const vehicleType = driver.vehicle_type as 'motor' | 'mobil' | null;
        const incompatible: string[] = [];

        const finalServices = filtered.filter((code) => {
            const allowed = SERVICE_VEHICLE_RULES[code];
            if (!allowed) return true;   // service tidak ada rule → allow (safety)
            if (!vehicleType) return true; // driver belum set kendaraan
            const ok = allowed.includes(vehicleType);
            if (!ok) incompatible.push(code);
            return ok;
        });

        if (incompatible.length > 0) {
            logger.warn('[driver.updateServices] Service tidak cocok dengan kendaraan', {
                driverId,
                vehicleType,
                incompatible,
            });
        }

        if (finalServices.length === 0) {
            throw ApiError.badRequest(
                `Tidak ada layanan yang cocok dengan kendaraan "${vehicleType}". ` +
                `Pilih layanan yang sesuai.`
            );
        }

        // 5. Update
        const { data, error } = await supabaseAdmin
            .from('driver_profiles')
            .update({ services: finalServices })
            .eq('user_id', driverId)
            .select()
            .single();

        if (error) throw ApiError.internal(error.message);
        return data;
    },

    // ============================================================
    // GET EARNINGS (with wallet info)
    // ============================================================
    async getEarnings(driverId: string) {
        const now = new Date();

        // Awal hari ini (00:00)
        const startOfToday = new Date(now);
        startOfToday.setHours(0, 0, 0, 0);

        // Awal minggu (Senin 00:00)
        const startOfWeek = new Date(now);
        const day = startOfWeek.getDay();
        const diff = day === 0 ? 6 : day - 1;
        startOfWeek.setDate(startOfWeek.getDate() - diff);
        startOfWeek.setHours(0, 0, 0, 0);

        // Awal bulan
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        // Query orders completed
        const { data: orders, error } = await supabaseAdmin
            .from('orders')
            .select('driver_earning, completed_at, status')
            .eq('driver_id', driverId)
            .eq('status', 'completed');

        if (error) throw ApiError.internal(error.message);

        const rows = orders ?? [];

        const sumSince = (since: Date) =>
            rows
                .filter((o: any) => {
                    if (!o.completed_at) return false;
                    return new Date(o.completed_at) >= since;
                })
                .reduce(
                    (sum: number, o: any) =>
                        sum + Number(o.driver_earning ?? 0),
                    0
                );

        const total = rows.reduce(
            (sum: number, o: any) => sum + Number(o.driver_earning ?? 0),
            0
        );

        const today = sumSince(startOfToday);
        const week = sumSince(startOfWeek);
        const month = sumSince(startOfMonth);

        // Pending: order aktif
        const { data: pendingOrders } = await supabaseAdmin
            .from('orders')
            .select('driver_earning')
            .eq('driver_id', driverId)
            .in('status', ['accepted', 'arrived', 'in_progress']);

        const pending = (pendingOrders ?? []).reduce(
            (sum: number, o: any) => sum + Number(o.driver_earning ?? 0),
            0
        );

        // 🆕 Ambil wallet info
        const { data: wallet } = await supabaseAdmin
            .from('driver_wallets')
            .select(
                'balance, cash_debt, total_earning, total_commission_paid, total_commission_owed'
            )
            .eq('driver_id', driverId)
            .maybeSingle();

        const walletBalance = Number(wallet?.balance ?? 0);
        const cashDebt = Number(wallet?.cash_debt ?? 0);

        // Pending payout (dana yang sedang ditarik)
        const { data: payouts } = await supabaseAdmin
            .from('payouts')
            .select('amount')
            .eq('driver_id', driverId)
            .in('status', ['pending', 'processing']);

        const pendingPayout = (payouts ?? []).reduce(
            (sum, p: any) => sum + Number(p.amount ?? 0),
            0
        );

        return {
            // Earning per periode
            today: Math.round(today),
            week: Math.round(week),
            month: Math.round(month),
            total: Math.round(total),
            pending: Math.round(pending),

            // 🆕 Wallet info
            balance: walletBalance,
            cash_debt: cashDebt,
            net_balance: walletBalance - cashDebt,
            total_commission_paid: Number(wallet?.total_commission_paid ?? 0),
            total_commission_owed: Number(wallet?.total_commission_owed ?? 0),
            pending_payout: Math.round(pendingPayout),
        };
    },

    // ============================================================
    // GET EARNINGS HISTORY
    // ============================================================
    async getEarningsHistory(driverId: string, limit = 50, offset = 0) {
        const { data, error } = await supabaseAdmin
            .from('orders')
            .select(
                `
                id, order_code, type, dropoff_name, pickup_name,
                driver_earning, completed_at, tariff_code, option_name,
                commission_amount, settlement_type, payment_method
                `
            )
            .eq('driver_id', driverId)
            .eq('status', 'completed')
            .order('completed_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw ApiError.internal(error.message);
        return data ?? [];
    },

    // ============================================================
    // GET PROFILE
    // ============================================================
    // ✅ SESUDAH — auto-heal
    async getProfile(driverId: string) {
        const { data, error } = await supabaseAdmin
            .from('driver_profiles')
            .select('*')
            .eq('user_id', driverId)
            .maybeSingle();         // ⬅️ return null, tidak error

        if (error) {
            logger.warn('[driver.getProfile] Query error', {
                driverId,
                error: error.message,
            });
            return null;
        }

        // 🆕 Auto-create kalau belum ada
        if (!data) {
            logger.info('[driver.getProfile] Auto-create', { driverId });

            const { data: created, error: createErr } = await supabaseAdmin
                .from('driver_profiles')
                .insert({
                    user_id: driverId,
                    vehicle_type: 'motor',
                    status: 'offline',
                    is_verified: false,
                    services: [],
                    rating_avg: 5.0,
                    total_trips: 0,
                })
                .select()
                .single();

            if (createErr) {
                logger.error('[driver.getProfile] Gagal auto-create', {
                    driverId,
                    error: createErr.message,
                });
                return null;
            }

            return created;
        }

        return data;
    },

    //verifikasi driver
    async submitVerification(
        driverId: string,
        input: {
            ktpNumber: string;
            simNumber: string;
            simType?: string;
            stnkNumber: string;
            plateNumber: string;
        },
        files: {
            ktp?: Express.Multer.File;
            sim?: Express.Multer.File;
            stnk?: Express.Multer.File;
            selfie?: Express.Multer.File;
        }
    ) {
        const { data: dp } = await supabaseAdmin
            .from('driver_profiles')
            .select('user_id')
            .eq('user_id', driverId)
            .maybeSingle();

        if (!dp) throw ApiError.notFound('Driver profile tidak ditemukan');

        // 🆕 Upload file → simpan PATH (bukan URL)
        const uploadFile = async (
            file: Express.Multer.File,
            prefix: string
        ): Promise<string> => {
            const ext = file.originalname.split('.').pop() ?? 'jpg';
            const fileName = `${driverId}/${prefix}-${Date.now()}.${ext}`;

            const { error } = await supabaseAdmin.storage
                .from('driver-documents')
                .upload(fileName, file.buffer, {
                    contentType: file.mimetype,
                    upsert: true,
                });

            if (error) throw ApiError.internal(error.message);

            // 🆕 Return PATH saja (mis. "500e3c50-.../ktp-xxx.jpg")
            return fileName;
        };

        // Ambil data lama (untuk preserve path kalau tidak ada upload baru)
        const { data: existing } = await supabaseAdmin
            .from('driver_verifications')
            .select('ktp_photo_url, sim_photo_url, stnk_photo_url, selfie_photo_url')
            .eq('driver_id', driverId)
            .maybeSingle();

        const ktpPath = files.ktp
            ? await uploadFile(files.ktp, 'ktp')
            : existing?.ktp_photo_url ?? null;

        const simPath = files.sim
            ? await uploadFile(files.sim, 'sim')
            : existing?.sim_photo_url ?? null;

        const stnkPath = files.stnk
            ? await uploadFile(files.stnk, 'stnk')
            : existing?.stnk_photo_url ?? null;

        const selfiePath = files.selfie
            ? await uploadFile(files.selfie, 'selfie')
            : existing?.selfie_photo_url ?? null;

        // Upsert verifikasi
        const { data, error } = await supabaseAdmin
            .from('driver_verifications')
            .upsert(
                {
                    driver_id: driverId,
                    ktp_photo_url: ktpPath,
                    sim_photo_url: simPath,
                    stnk_photo_url: stnkPath,
                    selfie_photo_url: selfiePath,
                    ktp_number: input.ktpNumber,
                    sim_number: input.simNumber,
                    sim_type: input.simType ?? null,
                    stnk_number: input.stnkNumber,
                    plate_number: input.plateNumber,
                    status: 'pending',
                    submitted_at: new Date().toISOString(),
                    rejection_reason: null,
                    reviewed_by: null,
                    reviewed_at: null,
                },
                { onConflict: 'driver_id' }
            )
            .select()
            .single();

        if (error) throw ApiError.internal(error.message);

        // Update driver_profiles
        await supabaseAdmin
            .from('driver_profiles')
            .update({
                ktp_number: input.ktpNumber,
                sim_number: input.simNumber,
            })
            .eq('user_id', driverId);

        logger.info('[driver.submitVerification]', {
            driverId,
            verificationId: data.id,
        });

        return data;
    },

    async getVerification(driverId: string) {
        const { data, error } = await supabaseAdmin
            .from('driver_verifications')
            .select('*')
            .eq('driver_id', driverId)
            .maybeSingle();

        if (error) throw ApiError.internal(error.message);
        if (!data) return null;

        // 🆕 Helper: generate signed URL dari path
        const signUrl = async (path: string | null): Promise<string | null> => {
            if (!path) return null;

            // Kalau sudah full URL (data lama), return as-is
            if (path.startsWith('http')) return path;

            const { data: urlData, error: signErr } = await supabaseAdmin.storage
                .from('driver-documents')
                .createSignedUrl(path, 3600); // valid 1 jam

            if (signErr) {
                logger.warn('[driver.getVerification] Sign URL gagal', {
                    path,
                    error: signErr.message,
                });
                return null;
            }

            return urlData?.signedUrl ?? null;
        };

        return {
            ...data,
            ktp_photo_url: await signUrl(data.ktp_photo_url),
            sim_photo_url: await signUrl(data.sim_photo_url),
            stnk_photo_url: await signUrl(data.stnk_photo_url),
            selfie_photo_url: await signUrl(data.selfie_photo_url),
            // 🆕 Kirim path asli juga (biar frontend tahu path tersimpan)
            _ktp_path: data.ktp_photo_url,
            _sim_path: data.sim_photo_url,
            _stnk_path: data.stnk_photo_url,
            _selfie_path: data.selfie_photo_url,
        };
    },

    // ============================================================
    // NEARBY DRIVERS
    // ============================================================
    async nearbyDrivers(
        lat: number,
        lng: number,
        radius = 5000,
        limit = 50
    ) {
        const { data, error } = await supabaseAdmin.rpc(
            'find_nearby_drivers',
            {
                p_lat: lat,
                p_lng: lng,
                p_radius_m: radius,
                p_limit: limit,
            }
        );
        if (error) throw ApiError.internal(error.message);
        if (!data || data.length === 0) return [];

        const driverIds = data.map((d: any) => d.user_id);

        const { data: profiles } = await supabaseAdmin
            .from('profiles')
            .select('id, full_name, avatar_url')
            .in('id', driverIds);

        const { data: driverProfiles } = await supabaseAdmin
            .from('driver_profiles')
            .select(
                'user_id, vehicle_type, plate_number, vehicle_brand, rating_avg, total_trips, current_location'
            )
            .in('user_id', driverIds);

        const profileMap = new Map(
            (profiles ?? []).map((p: any) => [p.id, p])
        );
        const dpMap = new Map(
            (driverProfiles ?? []).map((d: any) => [d.user_id, d])
        );

        return data
            .map((d: any) => {
                const profile = profileMap.get(d.user_id);
                const dp = dpMap.get(d.user_id);
                const coords = parseLocation(dp?.current_location);

                return {
                    id: d.user_id,
                    name: profile?.full_name ?? 'Driver',
                    avatar_url: profile?.avatar_url ?? null,
                    vehicle_type: dp?.vehicle_type ?? 'motor',
                    plate_number: dp?.plate_number ?? null,
                    vehicle_brand: dp?.vehicle_brand ?? null,
                    rating_avg: dp?.rating_avg ?? 5,
                    total_trips: dp?.total_trips ?? 0,
                    distance_m: d.distance_m,
                    coords,
                };
            })
            .filter((d: any) => d.coords);
    },
};