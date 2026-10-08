import { supabaseAdmin } from '../../config/supabase';
import { ApiError } from '../../utils/ApiError';

export const menuService = {
    async listByMerchant(merchantId: string) {
        const { data: categories } = await supabaseAdmin
            .from('menu_categories')
            .select('*')
            .eq('merchant_id', merchantId)
            .order('sort_order');

        const { data: items } = await supabaseAdmin
            .from('menu_items')
            .select('*')
            .eq('merchant_id', merchantId);

        return { categories: categories || [], items: items || [] };
    },

    async createCategory(merchantId: string, name: string, sort_order = 0) {
        const { data, error } = await supabaseAdmin
            .from('menu_categories')
            .insert({ merchant_id: merchantId, name, sort_order })
            .select()
            .single();
        if (error) throw ApiError.internal(error.message);
        return data;
    },

    async createItem(merchantId: string, item: any) {
        const { data, error } = await supabaseAdmin
            .from('menu_items')
            .insert({ ...item, merchant_id: merchantId })
            .select()
            .single();
        if (error) throw ApiError.internal(error.message);
        return data;
    },

    async updateItem(merchantId: string, itemId: number, patch: any) {
        const { data, error } = await supabaseAdmin
            .from('menu_items')
            .update(patch)
            .eq('id', itemId)
            .eq('merchant_id', merchantId)
            .select()
            .single();
        if (error) throw ApiError.internal(error.message);
        return data;
    },

    async deleteItem(merchantId: string, itemId: number) {
        const { error } = await supabaseAdmin
            .from('menu_items')
            .delete()
            .eq('id', itemId)
            .eq('merchant_id', merchantId);
        if (error) throw ApiError.internal(error.message);
    },
};