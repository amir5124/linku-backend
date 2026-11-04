// src/modules/region/region.service.ts
import { supabaseAdmin as sb } from '../../config/supabase';
import { ApiError } from '../../utils/ApiError';
import { audit } from '../admin/admin.service';

const CODE_RE = /^[a-z][a-z0-9_]{1,39}$/;
const TYPES = ['kota', 'kabupaten'];
const PUBLIC_COLUMNS = 'id, code, name, type, province, center_lat, center_lng, radius_km';

type RegionInput = {
    code?: string;
    name?: string;
    type?: string;
    province?: string | null;
    center_lat?: number;
    center_lng?: number;
    radius_km?: number;
    is_active?: boolean;
    sort_order?: number;
};

type OverrideInput = {
    min_fare?: number | null;
    per_km?: number | null;
    base_km?: number | null;
    is_active?: boolean;
};

const TARIFF_FIELDS = ['min_fare', 'per_km', 'base_km'] as const;

function num(v: unknown, label: string, min: number, max: number): number {
    const n = Number(v);
    if (v === '' || v === null || !Number.isFinite(n) || n < min || n > max) {
        throw ApiError.badRequest(`${label} harus angka antara ${min} dan ${max}`);
    }
    return n;
}

/** Validasi & bersihkan field wilayah. `requireCore` = wajib nama & titik pusat (saat buat baru). */
function clean(patch: RegionInput, requireCore: boolean) {
    const out: Record<string, any> = {};

    if (patch.name !== undefined) {
        const name = String(patch.name).trim();
        if (!name) throw ApiError.badRequest('Nama tidak boleh kosong');
        out.name = name;
    }
    if (patch.type !== undefined) {
        if (!TYPES.includes(String(patch.type))) throw ApiError.badRequest("Tipe harus 'kota' atau 'kabupaten'");
        out.type = String(patch.type);
    }
    if (patch.province !== undefined) out.province = String(patch.province ?? '').trim() || null;
    if (patch.center_lat !== undefined) out.center_lat = num(patch.center_lat, 'center_lat', -90, 90);
    if (patch.center_lng !== undefined) out.center_lng = num(patch.center_lng, 'center_lng', -180, 180);
    if (patch.radius_km !== undefined) out.radius_km = num(patch.radius_km, 'radius_km', 0.1, 500);
    if (patch.sort_order !== undefined) {
        const n = Number(patch.sort_order);
        if (!Number.isInteger(n) || n < 0) throw ApiError.badRequest('sort_order harus bilangan bulat ≥ 0');
        out.sort_order = n;
    }
    if (patch.is_active !== undefined) out.is_active = patch.is_active === true;

    if (requireCore) {
        for (const k of ['name', 'center_lat', 'center_lng']) {
            if (out[k] === undefined) throw ApiError.badRequest(`${k} wajib diisi`);
        }
    }
    return out;
}

/** Kolom tarif boleh null/kosong = pakai tarif dasar. */
function cleanOverride(body: OverrideInput) {
    const out: Record<string, any> = {};
    for (const k of TARIFF_FIELDS) {
        const v = (body as any)[k];
        if (v === undefined) continue;
        if (v === null || v === '') {
            out[k] = null;
            continue;
        }
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) {
            throw ApiError.badRequest(`${k} harus angka ≥ 0 (kosongkan untuk memakai tarif dasar)`);
        }
        out[k] = n;
    }
    if (body.is_active !== undefined) out.is_active = body.is_active === true;
    return out;
}

async function assertRegion(id: number) {
    const { data, error } = await sb.from('regions').select('id, name').eq('id', id).maybeSingle();
    if (error) throw ApiError.internal(error.message);
    if (!data) throw ApiError.notFound('Wilayah tidak ditemukan');
    return data as { id: number; name: string };
}

export const regionService = {
    // ============================================================
    // PUBLIK / CUSTOMER
    // ============================================================

    /** Daftar kota aktif untuk halaman "Pilih Kota". */
    async listPublic() {
        const { data, error } = await sb
            .from('regions')
            .select(PUBLIC_COLUMNS)
            .eq('is_active', true)
            .order('sort_order', { ascending: true })
            .order('name', { ascending: true });
        if (error) throw ApiError.internal(error.message);
        return data ?? [];
    },

    /** Kota yang dipilih user saat ini (null kalau belum memilih / sudah dinonaktifkan). */
    async getMine(userId: string) {
        const { data: p, error } = await sb.from('profiles').select('region_id').eq('id', userId).maybeSingle();
        if (error) throw ApiError.internal(error.message);
        if (!p?.region_id) return null;

        const { data: r, error: rErr } = await sb
            .from('regions')
            .select(PUBLIC_COLUMNS)
            .eq('id', p.region_id)
            .eq('is_active', true)
            .maybeSingle();
        if (rErr) throw ApiError.internal(rErr.message);
        return r ?? null;
    },

    /** Simpan pilihan kota user. regionId = null untuk mengosongkan. */
    async setMine(userId: string, regionId: unknown) {
        if (regionId === null) {
            const { error } = await sb.from('profiles').update({ region_id: null }).eq('id', userId);
            if (error) throw ApiError.internal(error.message);
            return null;
        }

        const id = Number(regionId);
        if (!Number.isInteger(id)) throw ApiError.badRequest('region_id tidak valid');

        const { data: r, error: rErr } = await sb
            .from('regions')
            .select(PUBLIC_COLUMNS)
            .eq('id', id)
            .eq('is_active', true)
            .maybeSingle();
        if (rErr) throw ApiError.internal(rErr.message);
        if (!r) throw ApiError.notFound('Kota tidak ditemukan atau belum aktif');

        const { error } = await sb.from('profiles').update({ region_id: id }).eq('id', userId);
        if (error) throw ApiError.internal(error.message);
        return r;
    },

    // ============================================================
    // ADMIN: WILAYAH
    // ============================================================
    async listAll() {
        const [{ data: regions, error }, { data: rts, error: rtErr }] = await Promise.all([
            sb.from('regions').select('*').order('sort_order', { ascending: true }).order('name', { ascending: true }),
            sb.from('region_tariffs').select('region_id'),
        ]);
        if (error) throw ApiError.internal(error.message);
        if (rtErr) throw ApiError.internal(rtErr.message);

        const count = new Map<number, number>();
        (rts ?? []).forEach((r: any) => count.set(r.region_id, (count.get(r.region_id) ?? 0) + 1));

        return (regions ?? []).map((r: any) => ({ ...r, tariff_count: count.get(r.id) ?? 0 }));
    },

    async create(body: RegionInput, adminId?: string) {
        const code = String(body.code ?? '').trim().toLowerCase();
        if (!CODE_RE.test(code)) {
            throw ApiError.badRequest('Kode harus huruf kecil/angka/_ dan diawali huruf (2–40 karakter), mis. kab_semarang');
        }
        const fields = clean(body, true);

        if (fields.sort_order === undefined) {
            const { data: last } = await sb
                .from('regions')
                .select('sort_order')
                .order('sort_order', { ascending: false })
                .limit(1)
                .maybeSingle();
            fields.sort_order = Number(last?.sort_order ?? 0) + 1;
        }

        const { data, error } = await sb.from('regions').insert({ code, ...fields }).select().single();
        if (error) {
            if ((error as any).code === '23505') throw ApiError.conflict('Kode wilayah sudah dipakai');
            throw ApiError.internal(error.message);
        }

        await audit(adminId, 'create_region', 'region', String(data.id), { code, ...fields });
        return data;
    },

    async update(id: number, patch: RegionInput, adminId?: string) {
        const fields = clean(patch, false);
        if (Object.keys(fields).length === 0) throw ApiError.badRequest('Tidak ada field diupdate');

        const { data, error } = await sb
            .from('regions')
            .update({ ...fields, updated_at: new Date().toISOString() })
            .eq('id', id)
            .select()
            .maybeSingle();
        if (error) throw ApiError.internal(error.message);
        if (!data) throw ApiError.notFound('Wilayah tidak ditemukan');

        await audit(adminId, 'update_region', 'region', String(id), fields);
        return data;
    },

    /** Wilayah yang sudah dipilih pengguna tidak dihapus: nonaktifkan saja. */
    async remove(id: number, adminId?: string) {
        const { count, error: cErr } = await sb
            .from('profiles')
            .select('id', { count: 'exact', head: true })
            .eq('region_id', id);
        if (cErr) throw ApiError.internal(cErr.message);
        if ((count ?? 0) > 0) {
            throw ApiError.conflict(`Wilayah sudah dipilih ${count} pengguna. Nonaktifkan saja, jangan dihapus.`);
        }

        const { data, error } = await sb.from('regions').delete().eq('id', id).select('id, code');
        if (error) throw ApiError.internal(error.message);
        if (!data?.length) throw ApiError.notFound('Wilayah tidak ditemukan');

        await audit(adminId, 'delete_region', 'region', String(id), { code: data[0].code });
    },

    // ============================================================
    // ADMIN: TARIF PER WILAYAH
    // ============================================================

    /** Semua tarif dasar + nilai override wilayah ini (override = null kalau belum diatur). */
    async listTariffs(regionId: number) {
        await assertRegion(regionId);

        const [{ data: tariffs, error }, { data: overrides, error: oErr }] = await Promise.all([
            sb
                .from('tariffs')
                .select('code, label, service_type, min_fare, per_km, base_km, is_active, sort_order')
                .order('sort_order', { ascending: true }),
            sb
                .from('region_tariffs')
                .select('tariff_code, min_fare, per_km, base_km, is_active')
                .eq('region_id', regionId),
        ]);
        if (error) throw ApiError.internal(error.message);
        if (oErr) throw ApiError.internal(oErr.message);

        const map = new Map<string, any>((overrides ?? []).map((o: any) => [o.tariff_code, o]));

        return (tariffs ?? []).map((t: any) => {
            const o = map.get(t.code);
            return {
                ...t,
                override: o
                    ? {
                        min_fare: o.min_fare,
                        per_km: o.per_km,
                        base_km: o.base_km,
                        is_active: o.is_active,
                    }
                    : null,
            };
        });
    },

    /** Buat / ubah override satu kode tarif di satu wilayah. */
    async saveTariff(regionId: number, code: string, body: OverrideInput, adminId?: string) {
        await assertRegion(regionId);

        const { data: base, error: bErr } = await sb.from('tariffs').select('code').eq('code', code).maybeSingle();
        if (bErr) throw ApiError.internal(bErr.message);
        if (!base) throw ApiError.notFound('Kode tarif tidak ditemukan');

        const fields = cleanOverride(body);

        const { data: existing, error: eErr } = await sb
            .from('region_tariffs')
            .select('min_fare, per_km, base_km, is_active')
            .eq('region_id', regionId)
            .eq('tariff_code', code)
            .maybeSingle();
        if (eErr) throw ApiError.internal(eErr.message);

        const merged = {
            min_fare: existing?.min_fare ?? null,
            per_km: existing?.per_km ?? null,
            base_km: existing?.base_km ?? null,
            is_active: existing?.is_active ?? true,
            ...fields,
        };

        if (merged.min_fare === null && merged.per_km === null && merged.base_km === null) {
            throw ApiError.badRequest(
                'Isi minimal satu dari min_fare, per_km, base_km. Untuk kembali ke tarif dasar, hapus override-nya.'
            );
        }

        const { data, error } = await sb
            .from('region_tariffs')
            .upsert(
                {
                    region_id: regionId,
                    tariff_code: code,
                    ...merged,
                    updated_at: new Date().toISOString(),
                },
                { onConflict: 'region_id,tariff_code' }
            )
            .select()
            .single();
        if (error) throw ApiError.internal(error.message);

        await audit(adminId, 'save_region_tariff', 'region', String(regionId), { tariff_code: code, ...merged });
        return data;
    },

    /** Hapus override: wilayah ini kembali memakai tarif dasar untuk kode tarif itu. */
    async removeTariff(regionId: number, code: string, adminId?: string) {
        const { data, error } = await sb
            .from('region_tariffs')
            .delete()
            .eq('region_id', regionId)
            .eq('tariff_code', code)
            .select('tariff_code');
        if (error) throw ApiError.internal(error.message);
        if (!data?.length) throw ApiError.notFound('Override tarif tidak ditemukan');

        await audit(adminId, 'delete_region_tariff', 'region', String(regionId), { tariff_code: code });
    },
};