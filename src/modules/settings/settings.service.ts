// src/modules/settings/settings.service.ts
//
// CRUD pengaturan aplikasi (tabel app_settings), termasuk pengaturan komisi.
// Kolom yang dipakai (dari kode yang sudah ada): key, value (teks), value_type,
// category, is_public, updated_by.

import { supabaseAdmin as sb } from '../../config/supabase';
import { ApiError } from '../../utils/ApiError';
import { audit } from '../admin/admin.service';

export const VALUE_TYPES = ['number', 'boolean', 'string', 'json'] as const;
export type ValueType = (typeof VALUE_TYPES)[number];

const KEY_RE = /^[a-z][a-z0-9_.]{1,63}$/;
const isCommissionKey = (k: string) => /commission|komisi/i.test(k);

/** Validasi nilai sesuai tipe dan kembalikan string yang akan disimpan. */
function normalizeValue(key: string, type: ValueType, raw: unknown, enforceRate: boolean): string {
    const v = typeof raw === 'string' ? raw.trim() : raw;

    switch (type) {
        case 'number': {
            const n = Number(v);
            if (v === '' || v === null || !Number.isFinite(n)) {
                throw ApiError.badRequest('Nilai harus berupa angka');
            }
            // Komisi dipakai sebagai pecahan (0.15 = 15%) oleh walletService.getCommissionRate
            if (enforceRate && isCommissionKey(key) && (n < 0 || n > 1)) {
                throw ApiError.badRequest('Komisi harus antara 0 dan 1 (mis. 0.15 untuk 15%)');
            }
            return String(n);
        }
        case 'boolean': {
            const s = String(v).toLowerCase();
            if (s !== 'true' && s !== 'false') throw ApiError.badRequest('Nilai harus true atau false');
            return s;
        }
        case 'json': {
            try {
                JSON.parse(String(v));
            } catch {
                throw ApiError.badRequest('Nilai bukan JSON yang valid');
            }
            return String(v);
        }
        default:
            if (v === undefined || v === null || String(v).trim() === '') {
                throw ApiError.badRequest('Nilai tidak boleh kosong');
            }
            return String(v);
    }
}

export const settingsService = {
    async list() {
        const { data, error } = await sb
            .from('app_settings')
            .select('*')
            .order('category', { ascending: true })
            .order('key', { ascending: true });
        if (error) throw ApiError.internal(error.message);
        return data ?? [];
    },

    async create(
        body: { key?: string; value?: unknown; value_type?: string; category?: string; is_public?: boolean },
        adminId?: string
    ) {
        const key = String(body.key ?? '').trim().toLowerCase();
        if (!KEY_RE.test(key)) {
            throw ApiError.badRequest('Key harus huruf kecil/angka/_/. dan diawali huruf (2–64 karakter)');
        }
        const type = (body.value_type ?? 'string') as ValueType;
        if (!VALUE_TYPES.includes(type)) throw ApiError.badRequest('value_type tidak valid');

        const value = normalizeValue(key, type, body.value, true);

        const { data, error } = await sb
            .from('app_settings')
            .insert({
                key,
                value,
                value_type: type,
                category: (body.category ?? 'general').trim() || 'general',
                is_public: body.is_public === true,
                updated_by: adminId ?? null,
            })
            .select()
            .single();
        if (error) {
            if ((error as any).code === '23505') throw ApiError.conflict('Key sudah ada');
            throw ApiError.internal(error.message);
        }

        await audit(adminId, 'create_setting', 'setting', key, { value, value_type: type });
        return data;
    },

    async update(
        key: string,
        body: { value?: unknown; value_type?: string; category?: string; is_public?: boolean },
        adminId?: string
    ) {
        const { data: existing, error: gErr } = await sb.from('app_settings').select('*').eq('key', key).maybeSingle();
        if (gErr) throw ApiError.internal(gErr.message);
        if (!existing) throw ApiError.notFound('Setting tidak ditemukan');

        const patch: Record<string, any> = { updated_by: adminId ?? null };

        const type = (body.value_type ?? existing.value_type) as ValueType;
        if (!VALUE_TYPES.includes(type)) throw ApiError.badRequest('value_type tidak valid');

        if (body.value !== undefined || body.value_type !== undefined) {
            // Kalau nilai lama berupa pecahan komisi (0–1), nilai baru juga harus pecahan
            const old = Number(existing.value);
            const enforceRate = existing.value_type === 'number' && Number.isFinite(old) && old >= 0 && old <= 1;
            patch.value = normalizeValue(key, type, body.value !== undefined ? body.value : existing.value, enforceRate);
            patch.value_type = type;
        }
        if (body.category !== undefined) patch.category = String(body.category).trim() || 'general';
        if (body.is_public !== undefined) patch.is_public = body.is_public === true;

        if (Object.keys(patch).length === 1) throw ApiError.badRequest('Tidak ada field yang diubah');

        const { data, error } = await sb.from('app_settings').update(patch).eq('key', key).select().single();
        if (error) throw ApiError.internal(error.message);

        await audit(adminId, 'update_setting', 'setting', key, { old: existing.value, new: data.value });
        return data;
    },

    async remove(key: string, adminId?: string) {
        const { data, error } = await sb.from('app_settings').delete().eq('key', key).select('key, value');
        if (error) throw ApiError.internal(error.message);
        if (!data?.length) throw ApiError.notFound('Setting tidak ditemukan');
        await audit(adminId, 'delete_setting', 'setting', key, { value: data[0].value });
    },
};