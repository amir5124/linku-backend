// src/modules/commission/commission.service.ts
//
// CRUD tarif komisi (tabel commission_rates).
// Cara fungsi SQL get_commission_rate memilih komisi:
//   1) baris dengan order_type + tariff_code yang cocok dan is_active
//   2) baris default jenis order (tariff_code NULL) dan is_active
//   3) 0.08 (bawaan)
// Kolom yang dipakai: order_type, tariff_code (boleh NULL), rate (pecahan 0–1), is_active.
//
// Penting: subquery di fungsi itu mengembalikan SATU baris. Kalau ada dua baris dengan
// (order_type, tariff_code) yang sama, fungsi akan error — karena itu duplikat ditolak di sini.

import { supabaseAdmin as sb } from '../../config/supabase';
import { ApiError } from '../../utils/ApiError';
import { audit } from '../admin/admin.service';

export const ORDER_TYPES = ['ride', 'send', 'food'] as const;
export const DEFAULT_KEY = '_default'; // dipakai di URL untuk tariff_code NULL

/** '_default' / kosong → null (default jenis order) */
export const parseTariffKey = (v?: string | null): string | null => {
    const s = String(v ?? '').trim();
    return !s || s === DEFAULT_KEY ? null : s;
};

function parseRate(v: unknown): number {
    const n = Number(v);
    if (v === '' || v === null || v === undefined || !Number.isFinite(n) || n < 0 || n > 1) {
        throw ApiError.badRequest('Komisi harus antara 0 dan 1 (mis. 0.15 untuk 15%)');
    }
    return n;
}

function assertOrderType(t: unknown): string {
    const v = String(t ?? '').trim();
    if (!(ORDER_TYPES as readonly string[]).includes(v)) {
        throw ApiError.badRequest(`order_type harus salah satu dari: ${ORDER_TYPES.join(', ')}`);
    }
    return v;
}

/** Filter baris berdasarkan (order_type, tariff_code), termasuk tariff_code NULL. */
const match = (q: any, orderType: string, tariffCode: string | null) => {
    const b = q.eq('order_type', orderType);
    return tariffCode === null ? b.is('tariff_code', null) : b.eq('tariff_code', tariffCode);
};

const label = (orderType: string, tariffCode: string | null) => `${orderType}:${tariffCode ?? 'default'}`;

export const commissionService = {
    async list() {
        const { data, error } = await sb
            .from('commission_rates')
            .select('*')
            .order('order_type', { ascending: true })
            .order('tariff_code', { ascending: true, nullsFirst: true });
        if (error) throw ApiError.internal(error.message);
        return data ?? [];
    },

    async create(
        body: { order_type?: string; tariff_code?: string | null; rate?: unknown; is_active?: boolean },
        adminId?: string
    ) {
        const orderType = assertOrderType(body.order_type);
        const tariffCode = parseTariffKey(body.tariff_code);
        const rate = parseRate(body.rate);
        const isActive = body.is_active !== false;

        // kode tarif harus ada
        if (tariffCode !== null) {
            const { data: t, error: tErr } = await sb.from('tariffs').select('code').eq('code', tariffCode).maybeSingle();
            if (tErr) throw ApiError.internal(tErr.message);
            if (!t) throw ApiError.badRequest('Kode tarif tidak ditemukan');
        }

        // cegah duplikat (lihat catatan di atas)
        const { count, error: cErr } = await match(
            sb.from('commission_rates').select('order_type', { count: 'exact', head: true }),
            orderType,
            tariffCode
        );
        if (cErr) throw ApiError.internal(cErr.message);
        if ((count ?? 0) > 0) throw ApiError.conflict('Komisi untuk kombinasi ini sudah ada. Ubah yang sudah ada.');

        const { data, error } = await sb
            .from('commission_rates')
            .insert({ order_type: orderType, tariff_code: tariffCode, rate, is_active: isActive })
            .select()
            .single();
        if (error) throw ApiError.internal(error.message);

        await audit(adminId, 'create_commission', 'commission', label(orderType, tariffCode), { rate, is_active: isActive });
        return data;
    },

    async update(
        orderTypeRaw: string,
        tariffKey: string,
        body: { rate?: unknown; is_active?: boolean },
        adminId?: string
    ) {
        const orderType = assertOrderType(orderTypeRaw);
        const tariffCode = parseTariffKey(tariffKey);

        const patch: Record<string, any> = {};
        if (body.rate !== undefined) patch.rate = parseRate(body.rate);
        if (body.is_active !== undefined) patch.is_active = body.is_active === true;
        if (Object.keys(patch).length === 0) throw ApiError.badRequest('Tidak ada field yang diubah');

        const { data: old, error: gErr } = await match(sb.from('commission_rates').select('*'), orderType, tariffCode).maybeSingle();
        if (gErr) throw ApiError.internal(gErr.message);
        if (!old) throw ApiError.notFound('Komisi tidak ditemukan');

        const { data, error } = await match(sb.from('commission_rates').update(patch), orderType, tariffCode).select();
        if (error) throw ApiError.internal(error.message);
        if (!data?.length) throw ApiError.notFound('Komisi tidak ditemukan');

        await audit(adminId, 'update_commission', 'commission', label(orderType, tariffCode), {
            old: { rate: old.rate, is_active: old.is_active },
            new: patch,
        });
        return data[0];
    },

    async remove(orderTypeRaw: string, tariffKey: string, adminId?: string) {
        const orderType = assertOrderType(orderTypeRaw);
        const tariffCode = parseTariffKey(tariffKey);

        const { data, error } = await match(sb.from('commission_rates').delete(), orderType, tariffCode).select();
        if (error) throw ApiError.internal(error.message);
        if (!data?.length) throw ApiError.notFound('Komisi tidak ditemukan');

        await audit(adminId, 'delete_commission', 'commission', label(orderType, tariffCode), { rate: data[0].rate });
    },
};