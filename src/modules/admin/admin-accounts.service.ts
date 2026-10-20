// src/modules/admin/admin-account.service.ts
import { supabaseAdmin as sb } from '../../config/supabase';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../config/logger';
import { notificationService } from '../notification/notification.service';
import { audit } from './admin.service';

type Role = 'customer' | 'driver' | 'merchant';
const ROLES: Role[] = ['customer', 'driver', 'merchant'];

const WALLET = {
    driver: { table: 'driver_wallets', key: 'driver_id', ledger: 'driver_wallet_ledger' },
    merchant: { table: 'merchant_wallets', key: 'user_id', ledger: 'merchant_wallet_ledger' },
    customer: { table: 'wallets', key: 'user_id', ledger: 'wallet_transactions' },
} as const;

const MAX_ADJUST = Number(process.env.ADMIN_ADJUST_MAX ?? 5_000_000);
const num = (v: any) => Number(v) || 0;
const rp = (n: number) => `Rp${n.toLocaleString('id-ID')}`;
const clean = (s?: string) => (s ?? '').replace(/[%_,()*\\]/g, '').trim();
const page = (o: { limit?: any; offset?: any }) => ({
    limit: Math.min(Math.max(Number(o.limit) || 20, 1), 100),
    offset: Math.max(Number(o.offset) || 0, 0),
});

// ─────────────────────────────────────────────────────────────
// Wallet helpers
// ─────────────────────────────────────────────────────────────
async function walletsFor(rows: { id: string; role: string }[]) {
    const map = new Map<string, { balance: number; cash_debt: number; pending: number }>();
    for (const role of ROLES) {
        const ids = rows.filter((r) => r.role === role).map((r) => r.id);
        if (!ids.length) continue;
        const w = WALLET[role];
        const { data, error } = await sb.from(w.table).select('*').in(w.key, ids);
        if (error) {
            logger.warn('[ADMIN] baca wallet gagal', { role, error: error.message });
            continue;
        }
        (data ?? []).forEach((r: any) =>
            map.set(r[w.key], {
                balance: num(r.balance),
                cash_debt: num(r.cash_debt),
                pending: num(r.pending_balance),
            })
        );
    }
    return map;
}

// ============================================================
// RINGKASAN
// ============================================================
export async function accountsSummary() {
    const out: Record<string, { count: number; total_balance: number; total_debt: number }> = {};
    for (const role of ROLES) {
        const { count } = await sb
            .from('profiles')
            .select('id', { count: 'exact', head: true })
            .eq('role', role);
        const w = WALLET[role];
        const { data } = await sb.from(w.table).select('*').limit(20000);
        out[role] = {
            count: count ?? 0,
            total_balance: (data ?? []).reduce((s: number, r: any) => s + num(r.balance), 0),
            total_debt: (data ?? []).reduce((s: number, r: any) => s + num(r.cash_debt), 0),
        };
    }
    return out;
}

// ============================================================
// DAFTAR
// ============================================================
export async function listAccounts(opts: {
    role?: string;
    search?: string;
    limit?: any;
    offset?: any;
}) {
    const { limit, offset } = page(opts);
    let q = sb
        .from('profiles')
        .select('id, full_name, email, phone, role, is_active, avatar_url, created_at', {
            count: 'exact',
        })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    if (opts.role && ROLES.includes(opts.role as Role)) q = q.eq('role', opts.role);
    else q = q.in('role', ROLES);

    const term = clean(opts.search);
    if (term) q = q.or(`full_name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%`);

    const { data, error, count } = await q;
    if (error) throw ApiError.internal(`profiles: ${error.message}`);

    const rows = data ?? [];
    const wallets = await walletsFor(rows as any);

    return {
        total: count ?? 0,
        items: rows.map((p: any) => {
            const w = wallets.get(p.id);
            return {
                ...p,
                is_active: p.is_active !== false,
                balance: w?.balance ?? 0,
                cash_debt: w?.cash_debt ?? 0,
                pending_balance: w?.pending ?? 0,
            };
        }),
    };
}

// ============================================================
// DETAIL
// ============================================================
export async function getAccount(id: string) {
    const { data: p, error } = await sb.from('profiles').select('*').eq('id', id).maybeSingle();
    if (error) throw ApiError.internal(`profiles: ${error.message}`);
    if (!p) throw ApiError.notFound('Pengguna tidak ditemukan');
    if (!ROLES.includes(p.role)) throw ApiError.badRequest('Role ini tidak punya dompet');

    const role = p.role as Role;
    const w = WALLET[role];
    const wallets = await walletsFor([{ id, role }]);

    // data khusus role
    let extra: any = null;
    if (role === 'merchant') {
        const { data } = await sb.from('merchant_profiles').select('*').eq('user_id', id).maybeSingle();
        extra = data;
    } else if (role === 'driver') {
        const { data } = await sb.from('driver_profiles').select('*').eq('user_id', id).maybeSingle();
        extra = data;
    }

    const orderCol = role === 'customer' ? 'customer_id' : role === 'driver' ? 'driver_id' : 'merchant_id';
    const { count: orders } = await sb
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq(orderCol, id);

    // ledger terbaru, dinormalkan
    const { data: led } = await sb
        .from(w.ledger)
        .select('*')
        .eq(w.key, id)
        .order('created_at', { ascending: false })
        .limit(30);

    const ledger = (led ?? []).map((r: any) => {
        if (role === 'customer') {
            const out = ['order_payment', 'withdraw'].includes(r.type) || num(r.amount) < 0;
            return {
                id: r.id,
                type: r.type,
                direction: out ? 'out' : 'in',
                amount: Math.abs(num(r.amount)),
                balance_after: num(r.balance_after),
                description: r.description ?? '',
                created_at: r.created_at,
            };
        }
        return {
            id: r.id,
            type: r.entry_type,
            direction: r.direction,
            amount: num(r.amount),
            balance_after: num(r.balance_after),
            description: r.description ?? '',
            created_at: r.created_at,
        };
    });

    const wal = wallets.get(id);
    return {
        profile: { ...p, is_active: p.is_active !== false },
        extra,
        orders: orders ?? 0,
        wallet: {
            balance: wal?.balance ?? 0,
            cash_debt: wal?.cash_debt ?? 0,
            pending_balance: wal?.pending ?? 0,
        },
        ledger,
    };
}

// ============================================================
// ADJUST SALDO (+ / −)
// ============================================================
export async function adjustBalance(
    id: string,
    input: { direction: 'credit' | 'debit'; amount: number; reason: string },
    adminId?: string
) {
    const amount = Math.round(Number(input.amount));
    const reason = (input.reason ?? '').trim();

    if (input.direction !== 'credit' && input.direction !== 'debit')
        throw ApiError.badRequest('direction harus credit atau debit');
    if (!Number.isFinite(amount) || amount <= 0) throw ApiError.badRequest('Nominal tidak valid');
    if (amount > MAX_ADJUST)
        throw ApiError.badRequest(`Maksimal sekali adjust ${rp(MAX_ADJUST)}`);
    if (reason.length < 5) throw ApiError.badRequest('Alasan wajib diisi (minimal 5 karakter)');

    const { data: p, error: pe } = await sb
        .from('profiles')
        .select('id, role, full_name')
        .eq('id', id)
        .maybeSingle();
    if (pe) throw ApiError.internal(`profiles: ${pe.message}`);
    if (!p) throw ApiError.notFound('Pengguna tidak ditemukan');
    if (!ROLES.includes(p.role)) throw ApiError.badRequest('Role ini tidak punya dompet');

    const role = p.role as Role;
    const w = WALLET[role];
    const signed = input.direction === 'credit' ? amount : -amount;

    for (let attempt = 1; attempt <= 5; attempt++) {
        // ── Fix #1: upsert dengan tipe eksplisit ──
        const upsertRow: Record<string, any> = { [w.key]: id };
        await sb.from(w.table).upsert(upsertRow, { onConflict: w.key, ignoreDuplicates: true });

        const { data: cur, error: re } = await sb.from(w.table).select('*').eq(w.key, id).single();
        if (re || !cur) throw ApiError.internal('Wallet tidak ditemukan');

        const before = num(cur.balance);
        const after = before + signed;
        if (after < 0)
            throw ApiError.badRequest(`Saldo tidak cukup. Saldo saat ini ${rp(before)}`);

        // optimistic lock: hanya berhasil kalau wallet belum berubah
        let upd = sb
            .from(w.table)
            .update({ balance: after, updated_at: new Date().toISOString() })
            .eq(w.key, id);
        upd = cur.updated_at ? upd.eq('updated_at', cur.updated_at) : upd.eq('balance', before);
        const { data: done, error: ue } = await upd.select(w.key);
        if (ue) throw ApiError.internal(`Update saldo gagal: ${ue.message}`);
        if (!done?.length) continue; // wallet berubah, ulangi

        const description = `Penyesuaian admin: ${reason}`;
        const meta = { admin_id: adminId ?? null, reason, direction: input.direction };
        let ledger_ok = true;

        // ── Fix #2: split insert per role (hindari union type error) ──
        if (role === 'customer') {
            const row = {
                user_id: id,
                type: 'adjustment',
                amount: signed, // bertanda: minus = pengurangan
                balance_after: after,
                reference_id: `ADJ-${Date.now()}`,
                description,
            };
            const { error: le } = await sb.from(w.ledger).insert(row);
            if (le) {
                logger.error('[ADMIN] ledger adjust gagal (saldo SUDAH berubah)', {
                    userId: id, role, before, after, error: le.message,
                });
                ledger_ok = false;
            }
        } else if (role === 'merchant') {
            const row = {
                user_id: id,
                order_id: null,
                entry_type: 'adjustment',
                amount,
                direction: input.direction === 'credit' ? 'in' : 'out',
                balance_after: after,
                cash_debt_after: num(cur.cash_debt),
                description,
                metadata: meta,
            };
            const { error: le } = await sb.from(w.ledger).insert(row);
            if (le) {
                logger.error('[ADMIN] ledger adjust gagal (saldo SUDAH berubah)', {
                    userId: id, role, before, after, error: le.message,
                });
                ledger_ok = false;
            }
        } else {
            // driver
            const row = {
                driver_id: id,
                entry_type: 'adjustment',
                amount,
                direction: input.direction === 'credit' ? 'in' : 'out',
                balance_after: after,
                cash_debt_after: num(cur.cash_debt),
                description,
                metadata: meta,
            };
            const { error: le } = await sb.from(w.ledger).insert(row);
            if (le) {
                logger.error('[ADMIN] ledger adjust gagal (saldo SUDAH berubah)', {
                    userId: id, role, before, after, error: le.message,
                });
                ledger_ok = false;
            }
        }

        await audit(adminId, 'adjust_balance', role, id, {
            direction: input.direction,
            amount,
            before,
            after,
            reason,
        });

        notificationService
            .sendToUser(id, {
                title: input.direction === 'credit' ? 'Saldo ditambahkan' : 'Saldo dikurangi',
                body: `${input.direction === 'credit' ? '+' : '-'}${rp(amount)} oleh admin. Alasan: ${reason}`,
                data: { type: 'balance_adjusted', amount: String(signed) },
            })
            .catch(() => { });

        return { balance_before: before, balance_after: after, ledger_ok };
    }
    throw ApiError.internal('Wallet sedang sibuk, coba lagi');
}