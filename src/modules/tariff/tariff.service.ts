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
    /**
     * Daftar tarif aktif. Kalau regionId diberikan dan wilayahnya aktif,
     * nilai min_fare / per_km / base_km ditimpa dengan nilai wilayah itu
     * (kolom yang tidak diatur di wilayah tetap memakai tarif dasar).
     * Struktur respons sama persis dengan sebelumnya, jadi aplikasi yang
     * menghitung harga dari daftar ini tidak perlu mengubah rumusnya.
     */
    async list(regionId?: number) {
        const { data, error } = await supabaseAdmin
            .from('tariffs')
            .select('*')
            .eq('is_active', true)
            .order('sort_order');
        if (error) throw ApiError.internal(error.message);
        const tariffs = data || [];

        if (!regionId) return tariffs;

        const { data: region, error: rErr } = await supabaseAdmin
            .from('regions')
            .select('id')
            .eq('id', regionId)
            .eq('is_active', true)
            .maybeSingle();
        if (rErr) throw ApiError.internal(rErr.message);
        if (!region) return tariffs; // wilayah tidak ada / nonaktif → tarif dasar

        const { data: overrides, error: oErr } = await supabaseAdmin
            .from('region_tariffs')
            .select('tariff_code, min_fare, per_km, base_km')
            .eq('region_id', regionId)
            .eq('is_active', true);
        if (oErr) throw ApiError.internal(oErr.message);

        const map = new Map<string, any>((overrides ?? []).map((o: any) => [o.tariff_code, o]));

        return tariffs.map((t: any) => {
            const o = map.get(t.code);
            if (!o) return t;
            return {
                ...t,
                min_fare: o.min_fare ?? t.min_fare,
                per_km: o.per_km ?? t.per_km,
                base_km: o.base_km ?? t.base_km,
                region_id: regionId,
                region_applied: true,
            };
        });
    },

    async listAll() {
        const { data, error } = await supabaseAdmin.from('tariffs').select('*').order('sort_order');
        if (error) throw ApiError.internal(error.message);
        return data || [];
    },

    /**
     * Tarif efektif satu kode tarif untuk sebuah titik: tarif dasar ditimpa
     * nilai wilayah HANYA kalau titik berada di dalam radius wilayah itu.
     * Hasil: { code, min_fare, per_km, base_km, region_id, region_applied }.
     * Dipakai server saat menghitung ongkos order (lihat catatan di calculate).
     */
    async getEffective(code: string, regionId?: number | null, lat?: number, lng?: number) {
        const { data, error } = await supabaseAdmin.rpc('get_effective_tariff', {
            p_code: code,
            p_region_id: regionId ?? null,
            p_lat: lat ?? null,
            p_lng: lng ?? null,
        });
        if (error) throw ApiError.internal(error.message);
        return Array.isArray(data) ? data[0] : data;
    },

    // CATATAN: calculate_tariff (RPC) masih memakai tarif dasar. Agar ongkos
    // yang DITAGIH server ikut tarif wilayah, rumusnya harus memakai hasil
    // getEffective() — lihat langkah lanjutan di catatan pengiriman.
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