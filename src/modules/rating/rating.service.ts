import { supabaseAdmin } from '../../config/supabase';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../config/logger';

export const ratingService = {
    // ============================================================
    // SUBMIT RATING (2 arah: customer ↔ driver)
    // ============================================================
    async submit(input: {
        orderId: number;
        reviewerId: string;
        rating: number;
        comment?: string;
        tags?: string[];
    }) {
        // 1. Validasi order
        const { data: order, error: oErr } = await supabaseAdmin
            .from('orders')
            .select('id, customer_id, driver_id, status')
            .eq('id', input.orderId)
            .single();

        if (oErr || !order) throw ApiError.notFound('Order tidak ditemukan');
        if (order.status !== 'completed') {
            throw ApiError.badRequest('Order belum selesai');
        }

        // 2. Tentukan reviewee (pasti string, atau throw)
        const revieweeId: string = (() => {
            if (order.customer_id === input.reviewerId) {
                // Customer menilai driver
                if (!order.driver_id) {
                    throw ApiError.badRequest('Order tidak punya driver');
                }
                return order.driver_id;
            }
            if (order.driver_id === input.reviewerId) {
                // Driver menilai customer
                return order.customer_id;
            }
            throw ApiError.forbidden('Bukan ordermu');
        })();

        // 3. Upsert rating
        const { data: rating, error: rErr } = await supabaseAdmin
            .from('ratings')
            .upsert(
                {
                    order_id: input.orderId,
                    reviewer_id: input.reviewerId,
                    reviewee_id: revieweeId,
                    rating: input.rating,
                    comment: input.comment ?? null,
                    tags: input.tags ?? [],
                },
                { onConflict: 'order_id,reviewer_id,reviewee_id' }
            )
            .select()
            .single();

        if (rErr) {
            logger.error('Gagal insert rating', { error: rErr });
            throw ApiError.internal(rErr.message);
        }

        // 4. Recalculate stats reviewee
        await ratingService.recalculateStats(revieweeId);

        return rating;
    },

    // ✅ SESUDAH — avg = NULL kalau 0 review
    async recalculateStats(userId: string) {
        const { data: agg, error: aggErr } = await supabaseAdmin
            .from('ratings')
            .select('rating')
            .eq('reviewee_id', userId);

        if (aggErr) {
            logger.warn('Gagal hitung rating avg', {
                error: aggErr,
                userId,
            });
            return;
        }

        const reviewCount = agg?.length ?? 0;

        // 🆕 Kalau belum ada review → NULL (bukan 0 / 5.0)
        const avg: number | null =
            reviewCount > 0
                ? Number(
                    (
                        agg!.reduce((s, r: any) => s + (r.rating ?? 0), 0) /
                        reviewCount
                    ).toFixed(2)
                )
                : null;

        // Cek role user
        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('role')
            .eq('id', userId)
            .maybeSingle();

        if (!profile) return;

        if (profile.role === 'driver') {
            const { count: tripsCount } = await supabaseAdmin
                .from('orders')
                .select('id', { count: 'exact', head: true })
                .eq('driver_id', userId)
                .eq('status', 'completed');

            await supabaseAdmin
                .from('driver_profiles')
                .update({
                    rating_avg: avg,        // ⬅️ bisa NULL
                    total_trips: tripsCount ?? 0,
                })
                .eq('user_id', userId);

            await supabaseAdmin
                .from('profiles')
                .update({
                    rating_avg: avg,        // ⬅️ bisa NULL
                    total_reviews: reviewCount,
                })
                .eq('id', userId);
        } else {
            const { count: ordersCount } = await supabaseAdmin
                .from('orders')
                .select('id', { count: 'exact', head: true })
                .eq('customer_id', userId)
                .eq('status', 'completed');

            await supabaseAdmin
                .from('profiles')
                .update({
                    rating_avg: avg,        // ⬅️ bisa NULL
                    total_reviews: reviewCount,
                    total_orders: ordersCount ?? 0,
                })
                .eq('id', userId);
        }

        logger.info('Rating stats recalculated', {
            userId,
            role: profile.role,
            rating_avg: avg,
            review_count: reviewCount,
        });
    },
    // ============================================================
    // GET BY ORDER
    // ============================================================
    async getByOrder(orderId: number) {
        const { data } = await supabaseAdmin
            .from('ratings')
            .select('*')
            .eq('order_id', orderId);
        return data ?? [];
    },

    // ============================================================
    // GET MINE — rating yang SAYA berikan untuk order ini
    // ============================================================
    async getMine(orderId: number, reviewerId: string) {
        const { data } = await supabaseAdmin
            .from('ratings')
            .select('rating, comment, tags')
            .eq('order_id', orderId)
            .eq('reviewer_id', reviewerId)
            .maybeSingle();

        if (!data) return null;

        return {
            rating: data.rating as number,
            message: (data.comment as string | null) ?? null,
            tags: (data.tags as string[] | null) ?? [],
            skipped: false,
        };
    },

    // ============================================================
    // LIST BY DRIVER (rating yang diterima driver)
    // ============================================================
    async listByDriver(driverId: string, limit = 20) {
        const { data } = await supabaseAdmin
            .from('ratings')
            .select('id, rating, comment, tags, created_at, reviewer_id')
            .eq('reviewee_id', driverId)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (!data || data.length === 0) return [];

        const reviewerIds = [
            ...new Set(data.map((r: any) => r.reviewer_id)),
        ];
        const { data: profiles } = await supabaseAdmin
            .from('profiles')
            .select('id, full_name, avatar_url')
            .in('id', reviewerIds);

        const profileMap = new Map(
            (profiles ?? []).map((p: any) => [p.id, p])
        );

        return data.map((r: any) => ({
            ...r,
            reviewer: profileMap.get(r.reviewer_id) ?? null,
        }));
    },

    // ============================================================
    // GET CUSTOMER STATS (untuk driver lihat info customer)
    // ============================================================
    async getCustomerStats(customerId: string) {
        const { data: profile, error } = await supabaseAdmin
            .from('profiles')
            .select('id, full_name, avatar_url, rating_avg, total_orders')
            .eq('id', customerId)
            .maybeSingle();

        if (error || !profile) return null;

        // Hitung jumlah review yang diterima customer
        const { count: reviewCount } = await supabaseAdmin
            .from('ratings')
            .select('id', { count: 'exact', head: true })
            .eq('reviewee_id', customerId);

        return {
            id: profile.id,
            full_name: profile.full_name,
            avatar_url: profile.avatar_url,
            rating_avg: profile.rating_avg ?? 5.0,
            total_orders: profile.total_orders ?? 0,
            review_count: reviewCount ?? 0,
        };
    },
};