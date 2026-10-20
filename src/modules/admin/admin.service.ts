// src/modules/admin/admin.service.ts
//
// Logika data untuk semua layar app admin: Beranda, Pesanan, Mitra, Keuangan, Akun.
// Disesuaikan dengan schema asli dari order.service.ts & wallet.service.ts.
// Batas hari memakai WIB (UTC+7).

import { supabaseAdmin as sb } from '../../config/supabase';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../config/logger';

// ─────────────────────────────────────────────────────────────
// Konfigurasi
// ─────────────────────────────────────────────────────────────
const T = {
    orders: 'orders',
    profiles: 'profiles',
    merchants: 'merchant_profiles',
    drivers: 'driver_profiles',
    driverWallets: 'driver_wallets', // kolom kunci: driver_id
    driverLedger: 'driver_wallet_ledger',
    withdrawals: 'wallet_withdrawals', // penarikan otomatis via LinkQu
    topups: 'wallet_topups', //            top up via LinkQu
    payouts: 'payouts', //                  pengajuan penarikan manual (driver) → perlu persetujuan admin
    audit: 'admin_audit_logs', //           buat dengan supabase/admin_audit_logs.sql
} as const;

/**
 * Status order yang SAH di database (lihat VALID_STATUS_TRANSITIONS di order.service.ts).
 * Penting: kolom status kemungkinan bertipe enum Postgres — mengirim nilai yang tidak
 * dikenal di filter `in(...)` membuat query error (500). Jangan tambah nilai di luar ini.
 */
const STATUS_GROUPS: Record<string, string[]> = {
    diproses: ['pending', 'accepted'],
    diantar: ['arrived', 'in_progress'],
    selesai: ['completed'],
    batal: ['cancelled'],
};

const SERVICE_LABEL: Record<string, string> = { ride: 'URide/UCar', send: 'USend', food: 'UFood' };

// ─────────────────────────────────────────────────────────────
// Util
// ─────────────────────────────────────────────────────────────
const WIB_MS = 7 * 60 * 60 * 1000;

/** Awal hari WIB, `daysAgo` hari ke belakang (negatif = ke depan). Hasil Date UTC. */
const startOfDayWIB = (daysAgo = 0) => {
    const w = new Date(Date.now() + WIB_MS);
    return new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate() - daysAgo) - WIB_MS);
};
const dateKeyWIB = (d: Date) => new Date(d.getTime() + WIB_MS).toISOString().slice(0, 10);

const num = (v: any) => Number(v) || 0;
const page = (o: { limit?: any; offset?: any }) => ({
    limit: Math.min(Math.max(Number(o.limit) || 20, 1), 100),
    offset: Math.max(Number(o.offset) || 0, 0),
});

function parseDateParam(
    raw: string | undefined,
    opts: { endOfDay?: boolean } = {}
): string | null {
    if (!raw) return null;
    const s = raw.trim();
    if (!s) return null;

    // Format YYYY-MM-DD → interpretasi sebagai WIB
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const [y, m, d] = s.split('-').map(Number);
        const baseUtc = Date.UTC(y, m - 1, d);
        // akhir hari eksklusif: +1 hari (jadi query pakai lt untuk `to`)
        const offset = opts.endOfDay ? 24 * 60 * 60 * 1000 : 0;
        return new Date(baseUtc - WIB_MS + offset).toISOString();
    }

    // ISO lengkap
    const parsed = new Date(s);
    if (Number.isNaN(parsed.getTime())) {
        throw ApiError.badRequest(`Tanggal tidak valid: "${s}"`);
    }
    return parsed.toISOString();
}
/** Bersihkan input pencarian dari karakter khusus filter PostgREST */
const cleanSearch = (s?: string) => (s ?? '').replace(/[%_,()*\\]/g, '').trim();
const chunk = <X,>(a: X[], n: number): X[][] =>
    Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

type CountQ = PromiseLike<{ count: number | null; error: any }>;
async function countRows(q: CountQ) {
    const { count, error } = await q;
    if (error) throw new Error(error.message);
    return count ?? 0;
}
/** Kalau tabel/kolom bermasalah, jangan menjatuhkan seluruh layar. */
async function safeCount(label: string, q: CountQ) {
    try {
        return await countRows(q);
    } catch (e: any) {
        logger.warn(`[ADMIN] ${label} gagal`, { error: e?.message });
        return 0;
    }
}
const head = { count: 'exact' as const, head: true };

/** Ubah error Supabase menjadi error yang terlihat di log server (pesan asli, bukan cuma "Internal server error"). */
function dbError(label: string, error: { message: string }) {
    logger.error(`[ADMIN] ${label} gagal`, { error: error.message });
    return ApiError.internal(`${label}: ${error.message}`);
}

/** Ambil profil sekaligus untuk banyak id. */
async function profileMap(ids: (string | null | undefined)[]) {
    const uniq = [...new Set(ids.filter(Boolean) as string[])];
    const map = new Map<string, any>();
    for (const part of chunk(uniq, 200)) {
        const { data, error } = await sb
            .from(T.profiles)
            .select('id, full_name, phone, role, is_active, created_at')
            .in('id', part);
        if (error) throw dbError('profiles', error);
        (data ?? []).forEach((p: any) => map.set(p.id, p));
    }
    return map;
}

/** Catatan aktivitas admin. Tidak pernah menggagalkan aksi utama. */
export async function audit(
    adminId: string | undefined,
    action: string,
    targetType: string,
    targetId: string,
    meta: Record<string, unknown> = {}
) {
    try {
        const { error } = await sb
            .from(T.audit)
            .insert({ admin_id: adminId ?? null, action, target_type: targetType, target_id: targetId, meta });
        if (error) logger.warn('[ADMIN AUDIT] gagal menulis log', { error: error.message });
    } catch (e: any) {
        logger.warn('[ADMIN AUDIT] gagal menulis log', { error: e?.message });
    }
}

// ─────────────────────────────────────────────────────────────
// Penarikan menunggu (dipakai Beranda & Keuangan)
// = penarikan LinkQu berstatus PENDING + pengajuan payout manual berstatus pending
// ─────────────────────────────────────────────────────────────
async function pendingWithdrawalStats() {
    const sum = async (table: string, status: string) => {
        const { data, error } = await sb.from(table).select('amount').eq('status', status).limit(5000);
        if (error) {
            logger.warn(`[ADMIN] hitung pending ${table} gagal`, { error: error.message });
            return { count: 0, total: 0 };
        }
        const rows = data ?? [];
        return { count: rows.length, total: rows.reduce((s: number, r: any) => s + Math.abs(num(r.amount)), 0) };
    };
    const [lq, po] = await Promise.all([sum(T.withdrawals, 'PENDING'), sum(T.payouts, 'pending')]);
    return { count: lq.count + po.count, total: lq.total + po.total, linkqu: lq, payouts: po };
}

/**
 * Total komisi dari pesanan SELESAI (orders.commission_amount) — definisi yang sama dengan daftar
 * komisi di menu Keuangan. Tanpa `range` = seluruh waktu. Dijumlahkan per 1.000 baris agar tidak
 * terpotong batas default Supabase. (Untuk data yang sangat besar, ganti dengan fungsi SQL SUM.)
 * Catatan: komisi merchant dicatat merchantWalletService dan belum ikut dihitung.
 */
async function sumCommission(range?: { from: Date; to: Date }) {
    const PAGE = 1000;
    let total = 0;
    for (let offset = 0; offset < 200_000; offset += PAGE) {
        let q = sb
            .from(T.orders)
            .select('commission_amount')
            .eq('status', 'completed')
            .gt('commission_amount', 0)
            .order('id', { ascending: true })
            .range(offset, offset + PAGE - 1);
        if (range) q = q.gte('completed_at', range.from.toISOString()).lt('completed_at', range.to.toISOString());

        const { data, error } = await q;
        if (error) {
            logger.warn('[ADMIN] hitung komisi gagal', { error: error.message });
            break;
        }
        const rows = data ?? [];
        total += rows.reduce((sum: number, r: any) => sum + num(r.commission_amount), 0);
        if (rows.length < PAGE) break;
    }
    return total;
}

// ─────────────────────────────────────────────────────────────
// BERANDA
// ─────────────────────────────────────────────────────────────
export async function getDashboard() {
    const days = Array.from({ length: 7 }, (_, i) => startOfDayWIB(6 - i)); // 6 hari lalu → hari ini
    const tomorrow = startOfDayWIB(-1);
    const todayStart = days[6];

    const perDay = Promise.all(
        days.map((d, i) =>
            countRows(
                sb
                    .from(T.orders)
                    .select('id', head)
                    .neq('status', 'cancelled')
                    .gte('created_at', d.toISOString())
                    .lt('created_at', (i < 6 ? days[i + 1] : tomorrow).toISOString())
            )
        )
    );

    const commissionTodayP = sumCommission({ from: todayStart, to: tomorrow });
    const commissionTotalP = sumCommission();

    const [counts, commissionToday, commissionTotal, activePartners, pendingMerchants, pendingDrivers, withdrawals] =
        await Promise.all([
            perDay,
            commissionTodayP,
            commissionTotalP,
            safeCount(
                'mitra aktif',
                sb
                    .from(T.profiles)
                    .select('id', head)
                    .in('role', ['driver', 'merchant'])
                    .or('is_active.is.null,is_active.eq.true')
            ),
            safeCount('merchant pending', sb.from(T.merchants).select('user_id', head).eq('is_verified', false)),
            safeCount('driver pending', sb.from(T.drivers).select('user_id', head).eq('is_verified', false)),
            pendingWithdrawalStats(),
        ]);

    return {
        orders_today: counts[6],
        commission_today: commissionToday,
        commission_total: commissionTotal,
        active_partners: activePartners,
        pending_verification: {
            merchants: pendingMerchants,
            drivers: pendingDrivers,
            total: pendingMerchants + pendingDrivers,
        },
        pending_withdrawals: withdrawals.count,
        orders_last_7_days: days.map((d, i) => ({ date: dateKeyWIB(d), count: counts[i] })),
    };
}

// ─────────────────────────────────────────────────────────────
// PESANAN
// ─────────────────────────────────────────────────────────────
const groupOf = (status: string) =>
    Object.entries(STATUS_GROUPS).find(([, v]) => v.includes(String(status).toLowerCase()))?.[0] ?? 'lainnya';

async function enrichOrders(rows: any[]) {
    const merchantIds = [...new Set(rows.map((o) => o.merchant_id).filter(Boolean))] as string[];

    const [people, merchantNames] = await Promise.all([
        profileMap(rows.flatMap((o) => [o.customer_id, o.driver_id])),
        (async () => {
            const m = new Map<string, string>();
            for (const part of chunk(merchantIds, 200)) {
                const { data, error } = await sb.from(T.merchants).select('user_id, store_name').in('user_id', part);
                if (error) {
                    logger.warn('[ADMIN] nama merchant gagal', { error: error.message });
                    continue;
                }
                (data ?? []).forEach((r: any) => m.set(r.user_id, r.store_name));
            }
            return m;
        })(),
    ]);

    return rows.map((o) => ({
        id: o.id,
        order_code: o.order_code ?? String(o.id),
        service: o.option_name || SERVICE_LABEL[String(o.type)] || String(o.type ?? ''),
        status: groupOf(o.status),
        raw_status: o.status,
        total: num(o.total_fare),
        payment_method: o.payment_method ?? null,
        // 'cash' → Tunai, selain itu (wallet/qris/bank_transfer) → Online
        settlement_type: o.settlement_type ?? (o.payment_method ? (o.payment_method === 'cash' ? 'cash' : 'gateway') : null),
        merchant_name: merchantNames.get(o.merchant_id) ?? null,
        driver_name: people.get(o.driver_id)?.full_name ?? null,
        customer_name: people.get(o.customer_id)?.full_name ?? null,
        dropoff_name: o.dropoff_name ?? null,
        created_at: o.created_at,
        completed_at: o.completed_at ?? null,
    }));
}

export async function listOrders(opts: {
    status?: string;
    search?: string;
    from?: string;   // ← BARU
    to?: string;     // ← BARU
    limit?: any;
    offset?: any;
}) {
    const { limit, offset } = page(opts);

    // ── Parse tanggal ──
    // `from` → awal hari WIB
    // `to`   → awal hari berikutnya (eksklusif) supaya tanggal `to` ikut terhitung
    const fromISO = parseDateParam(opts.from);
    const toISO = parseDateParam(opts.to, { endOfDay: true });

    if (fromISO && toISO && new Date(fromISO) > new Date(toISO)) {
        throw ApiError.badRequest('Tanggal "from" harus sebelum "to"');
    }

    let q = sb
        .from(T.orders)
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    const group = opts.status ? STATUS_GROUPS[opts.status] : undefined;
    if (group) q = q.in('status', group);

    const term = cleanSearch(opts.search);
    if (term) q = q.ilike('order_code', `%${term}%`);

    // ── Filter tanggal ──
    if (fromISO) q = q.gte('created_at', fromISO);
    if (toISO) q = q.lt('created_at', toISO);   // lt karena to sudah = awal hari berikutnya

    const { data, error, count } = await q;
    if (error) throw dbError('orders', error);
    return { items: await enrichOrders(data ?? []), total: count ?? 0 };
}


export async function getOrder(id: string) {
    const { data, error } = await sb.from(T.orders).select('*').eq('id', id).maybeSingle();
    if (error) throw dbError('orders', error);
    if (!data) throw ApiError.notFound('Pesanan tidak ditemukan');
    const [item] = await enrichOrders([data]);
    return { ...item, raw: data };
}

// ─────────────────────────────────────────────────────────────
// MITRA (merchant & driver)
// ─────────────────────────────────────────────────────────────
type PartnerType = 'merchant' | 'driver';

export async function listPartners(opts: {
    type: PartnerType;
    status?: string; // all | active | pending | suspended
    search?: string;
    limit?: any;
    offset?: any;
}) {
    const { limit, offset } = page(opts);
    const isMerchant = opts.type === 'merchant';

    const { data, error } = await sb
        .from(isMerchant ? T.merchants : T.drivers)
        .select('*')
        .limit(2000);
    if (error) throw dbError('partners', error);
    const rows = data ?? [];
    const people = await profileMap(rows.map((r: any) => r.user_id));

    let items = rows.map((r: any) => {
        const p = people.get(r.user_id);
        const suspended = p?.is_active === false;
        const verified = !!r.is_verified;
        return {
            user_id: r.user_id,
            name: (isMerchant ? r.store_name : null) ?? p?.full_name ?? 'Tanpa nama',
            owner_name: p?.full_name ?? null,
            phone: p?.phone ?? null,
            // merchant: alamat toko; driver: kendaraan
            address: isMerchant
                ? (r.address ?? null)
                : ([r.vehicle_brand, r.plate_number].filter(Boolean).join(' · ') || null),
            is_verified: verified,
            is_suspended: suspended,
            status: suspended ? 'suspended' : verified ? 'active' : 'pending',
            is_open: isMerchant ? (r.is_open ?? null) : null,
            rating_avg: r.rating_avg ?? null,
            total_orders: r.total_orders ?? r.total_trips ?? null,
            created_at: r.created_at ?? p?.created_at ?? null,
        };
    });

    const counts = {
        all: items.length,
        active: items.filter((i) => i.status === 'active').length,
        pending: items.filter((i) => i.status === 'pending').length,
        suspended: items.filter((i) => i.status === 'suspended').length,
    };

    if (opts.status && opts.status !== 'all') items = items.filter((i) => i.status === opts.status);
    const term = cleanSearch(opts.search).toLowerCase();
    if (term) {
        items = items.filter((i) => i.name.toLowerCase().includes(term) || (i.phone ?? '').includes(term));
    }

    // yang menunggu verifikasi tampil di atas, lalu terbaru
    items.sort((a, b) => {
        if ((a.status === 'pending') !== (b.status === 'pending')) return a.status === 'pending' ? -1 : 1;
        return String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
    });

    return { items: items.slice(offset, offset + limit), total: items.length, counts };
}

export async function verifyPartner(type: PartnerType, userId: string, adminId?: string) {
    const { data, error } = await sb
        .from(type === 'merchant' ? T.merchants : T.drivers)
        .update({ is_verified: true })
        .eq('user_id', userId)
        .select('user_id');
    if (error) throw dbError(`verify ${type}`, error);
    if (!data?.length) throw ApiError.notFound(`${type === 'merchant' ? 'Merchant' : 'Driver'} tidak ditemukan`);
    await audit(adminId, `verify_${type}`, type, userId);
}

export async function setPartnerSuspended(userId: string, suspended: boolean, adminId?: string) {
    const { data: prof, error: pe } = await sb.from(T.profiles).select('id, role').eq('id', userId).maybeSingle();
    if (pe) throw dbError('profiles', pe);
    if (!prof) throw ApiError.notFound('Akun tidak ditemukan');
    if (prof.role === 'admin') throw ApiError.forbidden('Akun admin tidak bisa ditangguhkan lewat menu mitra');

    const { error } = await sb.from(T.profiles).update({ is_active: !suspended }).eq('id', userId);
    if (error) throw dbError('suspend', error);

    if (suspended && prof.role === 'merchant') {
        await sb.from(T.merchants).update({ is_open: false }).eq('user_id', userId);
    }
    if (suspended && prof.role === 'driver') {
        await sb.from(T.drivers).update({ status: 'offline' }).eq('user_id', userId);
    }
    await audit(adminId, suspended ? 'suspend_partner' : 'activate_partner', prof.role, userId);
}

// ─────────────────────────────────────────────────────────────
// KEUANGAN
// ─────────────────────────────────────────────────────────────
type TxStatus = 'pending' | 'approved' | 'rejected' | 'success' | 'failed';

const linkquStatus = (s: any): TxStatus => {
    const v = String(s ?? '').toUpperCase();
    if (v === 'SUCCESS') return 'success';
    if (v === 'PENDING' || v === 'INQUIRY') return 'pending';
    return 'failed';
};

const payoutStatus = (s: any): TxStatus => {
    const v = String(s ?? '').toLowerCase();
    if (v === 'pending') return 'pending';
    if (v === 'approved') return 'approved';
    if (v === 'rejected') return 'rejected';
    if (['paid', 'success', 'completed'].includes(v)) return 'success';
    return 'failed';
};

export async function getFinanceSummary() {
    const p = await pendingWithdrawalStats();
    return { pending_withdrawals: { count: p.count, total: p.total, linkqu: p.linkqu, payouts: p.payouts } };
}

/** Penarikan LinkQu (otomatis; hanya dipantau, tidak perlu persetujuan). status: pending | success | failed | all */
async function listLinkquWithdrawals(opts: { status?: string; limit?: any; offset?: any }) {
    const { limit, offset } = page(opts);
    let q = sb
        .from(T.withdrawals)
        .select('*', { count: 'exact' })
        .neq('status', 'INQUIRY') // INQUIRY = baru dicek, belum dieksekusi
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    if (opts.status === 'pending') q = q.eq('status', 'PENDING');
    else if (opts.status === 'success') q = q.eq('status', 'SUCCESS');
    else if (opts.status === 'failed') q = q.not('status', 'in', '(INQUIRY,PENDING,SUCCESS)');

    const { data, error, count } = await q;
    if (error) throw dbError('wallet_withdrawals', error);
    const rows = data ?? [];
    const people = await profileMap(rows.map((r: any) => r.user_id));

    return {
        items: rows.map((r: any) => {
            const p = people.get(r.user_id);
            return {
                id: r.id,
                source: 'linkqu' as const,
                user_id: r.user_id,
                name: p?.full_name ?? 'Tanpa nama',
                role: p?.role ?? null,
                amount: num(r.amount),
                fee_admin: num(r.fee_admin),
                status: linkquStatus(r.status),
                raw_status: r.status,
                bank_name: r.bank_code ?? null,
                account_number: r.account_number ?? null,
                account_name: null,
                cash_debt: 0,
                created_at: r.created_at,
            };
        }),
        total: count ?? 0,
    };
}

/** Pengajuan payout manual (driver) — perlu persetujuan admin. */
async function listPayoutRequests(opts: { status?: string; limit?: any; offset?: any }) {
    const { limit, offset } = page(opts);
    let q = sb
        .from(T.payouts)
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
    if (opts.status && opts.status !== 'all') q = q.eq('status', opts.status);

    const { data, error, count } = await q;
    if (error) throw dbError('payouts', error);
    const rows = data ?? [];
    const people = await profileMap(rows.map((r: any) => r.driver_id));

    return {
        items: rows.map((r: any) => ({
            id: r.id,
            source: 'payout' as const,
            user_id: r.driver_id,
            name: people.get(r.driver_id)?.full_name ?? 'Tanpa nama',
            role: 'driver',
            amount: num(r.amount),
            fee_admin: 0,
            status: payoutStatus(r.status),
            raw_status: r.status,
            bank_name: r.bank_name ?? r.bank_code ?? null,
            account_number: r.account_number ?? null,
            account_name: r.account_name ?? null,
            cash_debt: 0,
            created_at: r.created_at,
        })),
        total: count ?? 0,
    };
}

/** source=linkqu (default) → penarikan otomatis; source=payout → pengajuan manual. */
export async function listWithdrawals(opts: { source?: string; status?: string; limit?: any; offset?: any }) {
    return opts.source === 'payout'
        ? listPayoutRequests({ ...opts, status: opts.status ?? 'pending' })
        : listLinkquWithdrawals({ ...opts, status: opts.status ?? 'pending' });
}

export async function listTopups(opts: { status?: string; limit?: any; offset?: any }) {
    const { limit, offset } = page(opts);
    let q = sb
        .from(T.topups)
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
    if (opts.status === 'pending') q = q.eq('status', 'PENDING');
    else if (opts.status === 'success') q = q.eq('status', 'SUCCESS');

    const { data, error, count } = await q;
    if (error) throw dbError('wallet_topups', error);
    const rows = data ?? [];
    const people = await profileMap(rows.map((r: any) => r.user_id));

    return {
        items: rows.map((r: any) => {
            const p = people.get(r.user_id);
            return {
                id: r.id,
                user_id: r.user_id,
                name: p?.full_name ?? 'Tanpa nama',
                role: p?.role ?? null,
                amount: num(r.nominal ?? r.amount), // nominal top up (tanpa fee)
                total_paid: num(r.amount),
                admin_fee: num(r.admin_fee),
                method: r.method ?? null,
                status: linkquStatus(r.status),
                raw_status: r.status,
                created_at: r.created_at,
            };
        }),
        total: count ?? 0,
    };
}

/** Komisi platform per pesanan selesai (terbaru dulu). */
export async function listCommissions(opts: { limit?: any; offset?: any }) {
    const { limit, offset } = page(opts);
    const { data, error, count } = await sb
        .from(T.orders)
        .select('id, order_code, type, option_name, settlement_type, commission_amount, completed_at', {
            count: 'exact',
        })
        .eq('status', 'completed')
        .gt('commission_amount', 0)
        .order('completed_at', { ascending: false })
        .range(offset, offset + limit - 1);
    if (error) throw dbError('orders', error);

    const totalCommission = await sumCommission();
    return {
        total_commission: totalCommission,
        items: (data ?? []).map((o: any) => ({
            id: o.id,
            order_code: o.order_code ?? String(o.id),
            service: o.option_name || SERVICE_LABEL[String(o.type)] || String(o.type ?? ''),
            settlement_type: o.settlement_type ?? null,
            commission: num(o.commission_amount),
            completed_at: o.completed_at,
        })),
        total: count ?? 0,
    };
}

/** Klaim pengajuan payout yang masih pending (mencegah dua admin memproses bersamaan). */
async function claimPayout(id: string, status: 'approved' | 'rejected') {
    const { data, error } = await sb
        .from(T.payouts)
        .update({ status })
        .eq('id', id)
        .eq('status', 'pending')
        .select('*');
    if (error) throw dbError('payouts', error);
    if (!data?.length) {
        const { data: exist } = await sb.from(T.payouts).select('id').eq('id', id).maybeSingle();
        throw exist ? ApiError.conflict('Pengajuan ini sudah diproses') : ApiError.notFound('Pengajuan tidak ditemukan');
    }
    return data[0] as any;
}

/**
 * Setujui pengajuan payout. Saldo driver sudah dipotong saat pengajuan (requestPayout),
 * jadi di sini hanya status yang berubah; transfer ke rekening dilakukan di luar app ini.
 */
export async function approvePayout(id: string, adminId?: string) {
    const p = await claimPayout(id, 'approved');
    await audit(adminId, 'approve_payout', 'payout', id, { driver_id: p.driver_id, amount: p.amount });
}

/** Tolak pengajuan payout dan KEMBALIKAN dana ke saldo driver. */
export async function rejectPayout(id: string, reason: string | undefined, adminId?: string) {
    const p = await claimPayout(id, 'rejected');
    const amount = num(p.amount);

    try {
        const { data: w, error: wErr } = await sb
            .from(T.driverWallets)
            .select('balance, cash_debt')
            .eq('driver_id', p.driver_id)
            .single();
        if (wErr || !w) throw new Error(wErr?.message ?? 'wallet driver tidak ditemukan');

        const newBalance = num(w.balance) + amount;
        const { error: uErr } = await sb
            .from(T.driverWallets)
            .update({ balance: newBalance })
            .eq('driver_id', p.driver_id);
        if (uErr) throw new Error(uErr.message);

        // entry_type memakai 'payout' (sudah dikenal) dengan arah 'in', agar aman bila kolomnya enum
        const { error: lErr } = await sb.from(T.driverLedger).insert({
            driver_id: p.driver_id,
            entry_type: 'payout',
            amount,
            direction: 'in',
            balance_after: newBalance,
            cash_debt_after: num(w.cash_debt),
            description: `Pengembalian payout #${id} (ditolak admin)`,
            metadata: { payout_id: id, reason: reason ?? null, refund: true },
        });
        if (lErr) logger.error('[ADMIN] ledger refund payout gagal', { error: lErr.message, payoutId: id });
    } catch (e: any) {
        // Dana gagal dikembalikan → buka lagi pengajuannya agar bisa dicoba ulang
        logger.error('[ADMIN] refund payout gagal, status dikembalikan ke pending', {
            payoutId: id,
            error: e?.message,
        });
        await sb.from(T.payouts).update({ status: 'pending' }).eq('id', id);
        throw ApiError.internal('Gagal mengembalikan dana ke saldo driver, coba lagi');
    }

    await audit(adminId, 'reject_payout', 'payout', id, {
        driver_id: p.driver_id,
        amount,
        reason: reason ?? null,
    });
}

// ─────────────────────────────────────────────────────────────
// AKUN
// ─────────────────────────────────────────────────────────────
export async function listAdmins() {
    const { data, error } = await sb
        .from(T.profiles)
        .select('id, full_name, email, phone, is_active, created_at')
        .eq('role', 'admin')
        .order('created_at', { ascending: true });
    if (error) throw dbError('profiles', error);
    return data ?? [];
}

export async function listAuditLogs(opts: { limit?: any; offset?: any }) {
    const { limit, offset } = page(opts);
    const { data, error, count } = await sb
        .from(T.audit)
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
    if (error) throw dbError(T.audit, error);
    const rows = data ?? [];
    const people = await profileMap(rows.map((r: any) => r.admin_id));
    return {
        items: rows.map((r: any) => ({ ...r, admin_name: people.get(r.admin_id)?.full_name ?? null })),
        total: count ?? 0,
    };
}