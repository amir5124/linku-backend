import { supabaseAdmin } from '../../config/supabase';
import { ApiError } from '../../utils/ApiError';

export type SavedKind = 'home' | 'office' | 'other';

export interface SavedAddressInput {
    kind: SavedKind;
    label?: string;
    name: string;
    address: string;
    place_id?: string;
    latitude: number;
    longitude: number;
}

export const savedAddressService = {
    async list(userId: string) {
        const { data, error } = await supabaseAdmin.rpc('get_saved_addresses', {
            p_user_id: userId,
        });
        if (error) throw ApiError.internal(error.message);
        return data || [];
    },

    async upsert(userId: string, input: SavedAddressInput) {
        const { data, error } = await supabaseAdmin
            .from('saved_addresses')
            .upsert(
                {
                    user_id: userId,
                    kind: input.kind,
                    label: input.label ?? null,
                    name: input.name,
                    address: input.address,
                    place_id: input.place_id ?? null,
                    location: `POINT(${input.longitude} ${input.latitude})`,
                },
                { onConflict: 'user_id,kind' }
            )
            .select()
            .single();
        if (error) throw ApiError.internal(error.message);
        return data;
    },

    async remove(userId: string, kind: SavedKind) {
        const { error } = await supabaseAdmin
            .from('saved_addresses')
            .delete()
            .eq('user_id', userId)
            .eq('kind', kind);
        if (error) throw ApiError.internal(error.message);
        return true;
    },

    async get(userId: string, kind: SavedKind) {
        const { data } = await supabaseAdmin
            .from('saved_addresses')
            .select('*')
            .eq('user_id', userId)
            .eq('kind', kind)
            .maybeSingle();
        return data;
    },
};