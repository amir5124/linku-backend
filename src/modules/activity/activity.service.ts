import { supabaseAdmin } from '../../config/supabase';
export type QuoteBody = {
    service: 'ride' | 'send' | 'food';
    origin_name?: string | null;
    origin_lat?: number | null;
    origin_lng?: number | null;
    dest_name?: string | null;
    dest_lat?: number | null;
    dest_lng?: number | null;
    option_name?: string | null;
    price?: number | null;
    eta_min?: number | null;
    distance_km?: number | null;
};

export const activityService = {
    /** User baru membuka app. Hanya last_opened_at yang di-update, kolom lain tidak tertimpa. */
    async ping(userId: string): Promise<void> {
        const { error } = await supabaseAdmin
            .from('user_presence')
            .upsert(
                { user_id: userId, last_opened_at: new Date().toISOString() },
                { onConflict: 'user_id' }
            );
        if (error) throw error;
    },

    /** User melihat harga. user_id selalu dari token, bukan dari body. */
    async trackQuote(userId: string, body: QuoteBody): Promise<void> {
        const { error } = await supabaseAdmin.rpc('track_quote', {
            p: { ...body, user_id: userId },
        });
        if (error) throw error;
    },
};