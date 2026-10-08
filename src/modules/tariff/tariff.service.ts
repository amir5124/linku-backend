import { supabaseAdmin } from '../../config/supabase';
import { ApiError } from '../../utils/ApiError';

export const tariffService = {
    async list() {
        const { data, error } = await supabaseAdmin
            .from('tariffs')
            .select('*')
            .eq('is_active', true)
            .order('sort_order');
        if (error) throw ApiError.internal(error.message);
        return data || [];
    },

    async listAll() {
        const { data, error } = await supabaseAdmin
            .from('tariffs')
            .select('*')
            .order('sort_order');
        if (error) throw ApiError.internal(error.message);
        return data || [];
    },

    async calculate(code: string, distanceKm: number) {
        const { data, error } = await supabaseAdmin.rpc('calculate_tariff', {
            p_code: code,
            p_distance_km: distanceKm,
        });
        if (error) throw ApiError.internal(error.message);
        return Array.isArray(data) ? data[0] : data;
    },

    async update(code: string, patch: {
        label?: string;
        min_fare?: number;
        per_km?: number;
        base_km?: number;
        capacity?: number;
        eta_min?: number;
        desc_text?: string;
        is_active?: boolean;
        sort_order?: number;
    }) {
        const clean: Record<string, any> = {};
        for (const k of ['label', 'min_fare', 'per_km', 'base_km', 'capacity', 'eta_min', 'desc_text', 'is_active', 'sort_order']) {
            if ((patch as any)[k] !== undefined) clean[k] = (patch as any)[k];
        }
        if (Object.keys(clean).length === 0) throw ApiError.badRequest('Tidak ada field diupdate');

        const { data, error } = await supabaseAdmin
            .from('tariffs')
            .update(clean)
            .eq('code', code)
            .select()
            .single();
        if (error) throw ApiError.internal(error.message);
        return data;
    },
};