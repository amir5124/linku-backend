// src/modules/tariff/tariff.service.ts
import { supabaseAdmin } from '../../config/supabase';
import { ApiError } from '../../utils/ApiError';
import { audit } from '../admin/admin.service';

const CODE_RE = /^[a-z][a-z0-9_]{1,31}$/;

type TariffInput = {
    code?: string;
    label?: string;
    min_fare?: number;
    per_km?: number;
    base_km?: number;
    capacity?: number;
    eta_min?: number;
    desc_text?: string;
    is_active?: boolean;
    sort_order?: number;
};

const MONEY_FIELDS = ['min_fare', 'per_km', 'base_km'] as const; // desimal ≥ 0
const INT_FIELDS = ['capacity', 'eta_min', 'sort_order'] as const; // bilangan bulat ≥ 0

/** Validasi & bersihkan field. `requireCore` = wajib label, min_fare, per_km, base_km (saat buat baru). */
function clean(patch: TariffInput, requireCore: boolean) {
    const out: Record<string, any> = {};

    if (patch.label !== undefined) {
        const label = String(patch.label).trim();
        if (!label) throw ApiError.badRequest('Label tidak boleh kosong');
        out.label = label;
    }
    for (const k of MONEY_FIELDS) {
        const v = (patch as any)[k];
        if (v === undefined) continue;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) throw ApiError.badRequest(`${k} harus angka ≥ 0`);
        out[k] = n;
    }
    for (const k of INT_FIELDS) {
        const v = (patch as any)[k];
        if (v === undefined) continue;
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) throw ApiError.badRequest(`${k} harus bilangan bulat ≥ 0`);
        out[k] = n;
    }
    if (patch.desc_text !== undefined) out.desc_text = String(patch.desc_text).trim();
    if (patch.is_active !== undefined) out.is_active = patch.is_active === true;

    if (requireCore) {
        for (const k of ['label', 'min_fare', 'per_km', 'base_km']) {
            if (out[k] === undefined) throw ApiError.badRequest(`${k} wajib diisi`);
        }
    }
    return out;
}

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
        const { data, error } = await supabaseAdmin.from('tariffs').select('*').order('sort_order');
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

    async create(body: TariffInput, adminId?: string) {
        const code = String(body.code ?? '').trim().toLowerCase();
        if (!CODE_RE.test(code)) {
            throw ApiError.badRequest('Kode harus huruf kecil/angka/_ dan diawali huruf (2–32 karakter), mis. uride_s');
        }
        const fields = clean(body, true);

        // sort_order default: di paling akhir
        if (fields.sort_order === undefined) {
            const { data: last } = await supabaseAdmin
                .from('tariffs')
                .select('sort_order')
                .order('sort_order', { ascending: false })
                .limit(1)
                .maybeSingle();
            fields.sort_order = Number(last?.sort_order ?? 0) + 1;
        }
        if (fields.is_active === undefined) fields.is_active = true;

        const { data, error } = await supabaseAdmin
            .from('tariffs')
            .insert({ code, ...fields })
            .select()
            .single();
        if (error) {
            if ((error as any).code === '23505') throw ApiError.conflict('Kode tarif sudah dipakai');
            throw ApiError.internal(error.message);
        }

        await audit(adminId, 'create_tariff', 'tariff', code, fields);
        return data;
    },

    async update(code: string, patch: TariffInput, adminId?: string) {
        const fields = clean(patch, false);
        if (Object.keys(fields).length === 0) throw ApiError.badRequest('Tidak ada field diupdate');

        const { data, error } = await supabaseAdmin
            .from('tariffs')
            .update(fields)
            .eq('code', code)
            .select()
            .maybeSingle();
        if (error) throw ApiError.internal(error.message);
        if (!data) throw ApiError.notFound('Tarif tidak ditemukan');

        await audit(adminId, 'update_tariff', 'tariff', code, fields);
        return data;
    },

    /** Tarif yang sudah dipakai pesanan tidak boleh dihapus — nonaktifkan saja. */
    async remove(code: string, adminId?: string) {
        const { count, error: cErr } = await supabaseAdmin
            .from('orders')
            .select('id', { count: 'exact', head: true })
            .eq('tariff_code', code);
        if (cErr) throw ApiError.internal(cErr.message);
        if ((count ?? 0) > 0) {
            throw ApiError.conflict(`Tarif sudah dipakai ${count} pesanan. Nonaktifkan saja, jangan dihapus.`);
        }

        const { data, error } = await supabaseAdmin.from('tariffs').delete().eq('code', code).select('code');
        if (error) throw ApiError.internal(error.message);
        if (!data?.length) throw ApiError.notFound('Tarif tidak ditemukan');

        await audit(adminId, 'delete_tariff', 'tariff', code);
    },
};