// src/modules/merchant/merchant.service.ts
import { supabaseAdmin } from '../../config/supabase';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../config/logger';

export const merchantService = {
    // ============================================================
    // PUBLIC — Browse merchant (customer/driver)
    // ============================================================

    /**
     * Cari merchant terdekat dari koordinat customer.
     * Coba pakai PostGIS function `nearby_merchants` dulu.
     * Kalau function belum ada → fallback: ambil semua merchant is_open.
     */
    async findNearby(lat: number, lng: number, radiusM = 5000) {
        // Coba RPC (PostGIS)
        const { data, error } = await supabaseAdmin.rpc('nearby_merchants', {
            p_lat: lat,
            p_lng: lng,
            p_radius: radiusM,
        });

        if (error) {
            logger.warn('RPC nearby_merchants gagal, fallback', {
                error: error.message,
            });

            // Fallback: ambil merchant yang buka (tanpa distance)
            const { data: fallback } = await supabaseAdmin
                .from('merchant_profiles')
                .select(
                    'user_id, store_name, description, address, latitude, longitude, logo_url, is_open, rating_avg, total_orders'
                )
                .eq('is_open', true)
                .not('latitude', 'is', null)
                .not('longitude', 'is', null)
                .limit(20);

            return fallback ?? [];
        }

        return data ?? [];
    },

    /**
     * Lihat profil publik toko (tanpa data sensitif).
     */
    async getPublicProfile(merchantId: string) {
        const { data, error } = await supabaseAdmin
            .from('merchant_profiles')
            .select(
                'user_id, store_name, description, address, latitude, longitude, logo_url, cover_url, is_open, is_verified, rating_avg, total_orders, open_hours, created_at'
            )
            .eq('user_id', merchantId)
            .maybeSingle();

        if (error) {
            logger.error('getPublicProfile error', { error, merchantId });
            throw ApiError.internal('Gagal mengambil profil merchant');
        }

        return data;
    },

    /**
     * Lihat menu publik toko (kategori + item tersedia).
     */
    async getPublicMenu(merchantId: string) {
        const { data: categories, error: catErr } = await supabaseAdmin
            .from('menu_categories')
            .select('id, name, sort_order')
            .eq('merchant_id', merchantId)
            .order('sort_order', { ascending: true });

        if (catErr) {
            logger.error('getPublicMenu categories error', { error: catErr, merchantId });
            throw ApiError.internal('Gagal mengambil kategori menu');
        }

        const { data: items, error: itemErr } = await supabaseAdmin
            .from('menu_items')
            .select(
                'id, merchant_id, category_id, name, description, price, image_url, is_available, stock'
            )
            .eq('merchant_id', merchantId)
            .eq('is_available', true)
            .order('created_at', { ascending: false });

        if (itemErr) {
            logger.error('getPublicMenu items error', { error: itemErr, merchantId });
            throw ApiError.internal('Gagal mengambil menu');
        }

        return {
            merchant_id: merchantId,
            categories: categories ?? [],
            items: items ?? [],
        };
    },

    // ============================================================
    // UPSERT STORE — buat atau update profil toko
    // ============================================================
    async upsertStore(userId: string, data: {
        store_name: string;
        description?: string;
        address?: string;
        latitude?: number;
        longitude?: number;
        logo_url?: string;
        cover_url?: string;
        is_open?: boolean;
        open_hours?: any;
    }) {
        if (!data.store_name) throw ApiError.badRequest('Nama toko wajib diisi');

        const payload: any = {
            user_id: userId,
            store_name: data.store_name,
            description: data.description ?? null,
            address: data.address ?? null,
            logo_url: data.logo_url ?? null,
            cover_url: data.cover_url ?? null,
            is_open: data.is_open ?? false,
            open_hours: data.open_hours ?? null,
        };

        // Kalau lat/lng dikirim, set location + lat + lng
        if (typeof data.latitude === 'number' && typeof data.longitude === 'number') {
            if (
                data.latitude < -90 || data.latitude > 90 ||
                data.longitude < -180 || data.longitude > 180
            ) {
                throw ApiError.badRequest('Koordinat tidak valid');
            }

            payload.latitude = data.latitude;
            payload.longitude = data.longitude;
            payload.location = `SRID=4326;POINT(${data.longitude} ${data.latitude})`;
        }

        const { data: store, error } = await supabaseAdmin
            .from('merchant_profiles')
            .upsert(payload, { onConflict: 'user_id' })
            .select()
            .single();

        if (error) {
            logger.error('upsertStore error', { error, userId });
            throw ApiError.internal('Gagal menyimpan profil toko');
        }
        return store;
    },

    // ============================================================
    // GET STORE — ambil profil toko milik merchant
    // ============================================================
    async getMyStore(userId: string) {
        const { data, error } = await supabaseAdmin
            .from('merchant_profiles')
            .select('*')
            .eq('user_id', userId)
            .maybeSingle();

        if (error) throw ApiError.internal('Gagal mengambil profil toko');
        return data;
    },

    // ============================================================
    // TOGGLE OPEN — buka/tutup toko
    // ============================================================
    async setOpen(userId: string, isOpen: boolean) {
        const { data, error } = await supabaseAdmin
            .from('merchant_profiles')
            .update({ is_open: isOpen })
            .eq('user_id', userId)
            .select()
            .single();

        if (error) throw ApiError.internal('Gagal mengubah status toko');
        return data;
    },

    // ============================================================
    // CATEGORIES
    // ============================================================
    async listCategories(userId: string) {
        const { data, error } = await supabaseAdmin
            .from('menu_categories')
            .select('*')
            .eq('merchant_id', userId)
            .order('sort_order', { ascending: true });

        if (error) throw ApiError.internal('Gagal mengambil kategori');
        return data ?? [];
    },

    async addCategory(userId: string, name: string) {
        if (!name) throw ApiError.badRequest('Nama kategori wajib diisi');

        const { data, error } = await supabaseAdmin
            .from('menu_categories')
            .insert({ merchant_id: userId, name })
            .select()
            .single();

        if (error) throw ApiError.internal('Gagal menambah kategori');
        return data;
    },

    async deleteCategory(userId: string, categoryId: number) {
        const { error } = await supabaseAdmin
            .from('menu_categories')
            .delete()
            .eq('id', categoryId)
            .eq('merchant_id', userId);

        if (error) throw ApiError.internal('Gagal menghapus kategori');
    },

    // ============================================================
    // MENU ITEMS
    // ============================================================
    async listMenu(userId: string) {
        const { data, error } = await supabaseAdmin
            .from('menu_items')
            .select('*, menu_categories(name)')
            .eq('merchant_id', userId)
            .order('created_at', { ascending: false });

        if (error) throw ApiError.internal('Gagal mengambil menu');
        return data ?? [];
    },

    async addMenuItem(userId: string, data: {
        category_id?: number;
        name: string;
        description?: string;
        price: number;
        image_url?: string;
        stock?: number;
    }) {
        if (!data.name) throw ApiError.badRequest('Nama menu wajib diisi');
        if (!data.price || data.price <= 0) {
            throw ApiError.badRequest('Harga wajib diisi dan > 0');
        }

        const { data: menu, error } = await supabaseAdmin
            .from('menu_items')
            .insert({
                merchant_id: userId,
                category_id: data.category_id ?? null,
                name: data.name,
                description: data.description ?? null,
                price: data.price,
                image_url: data.image_url ?? null,
                stock: data.stock ?? null,
                is_available: true,
            })
            .select()
            .single();

        if (error) {
            logger.error('addMenuItem error', { error, userId });
            throw ApiError.internal('Gagal menambah menu');
        }
        return menu;
    },

    async updateMenuItem(userId: string, itemId: number, data: any) {
        const { data: menu, error } = await supabaseAdmin
            .from('menu_items')
            .update({
                category_id: data.category_id,
                name: data.name,
                description: data.description,
                price: data.price,
                image_url: data.image_url,
                is_available: data.is_available,
                stock: data.stock,
                updated_at: new Date().toISOString(),
            })
            .eq('id', itemId)
            .eq('merchant_id', userId)
            .select()
            .single();

        if (error) throw ApiError.internal('Gagal update menu');
        return menu;
    },

    async toggleMenuAvailability(userId: string, itemId: number) {
        const { data: existing } = await supabaseAdmin
            .from('menu_items')
            .select('is_available')
            .eq('id', itemId)
            .eq('merchant_id', userId)
            .single();

        if (!existing) throw ApiError.notFound('Menu tidak ditemukan');

        const { data, error } = await supabaseAdmin
            .from('menu_items')
            .update({ is_available: !existing.is_available })
            .eq('id', itemId)
            .eq('merchant_id', userId)
            .select()
            .single();

        if (error) throw ApiError.internal('Gagal toggle menu');
        return data;
    },

    async deleteMenuItem(userId: string, itemId: number) {
        const { error } = await supabaseAdmin
            .from('menu_items')
            .delete()
            .eq('id', itemId)
            .eq('merchant_id', userId);

        if (error) throw ApiError.internal('Gagal menghapus menu');
    },
};