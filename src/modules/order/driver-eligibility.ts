// src/modules/order/driver-eligibility.ts
import { supabaseAdmin } from '../../config/supabase';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../config/logger';

const rp = (n: number) => `Rp${Number(n).toLocaleString('id-ID')}`;

async function num(key: string, fallback: number) {
    const { data } = await supabaseAdmin
        .from('app_settings').select('value').eq('key', key).maybeSingle();
    const n = Number(data?.value);
    return data?.value != null && Number.isFinite(n) && n >= 0 ? n : fallback;
}

export async function getDriverRules() {
    const [min, free] = await Promise.all([
        num('driver_min_balance', 10_000),
        num('driver_free_orders', 5),
    ]);
    return { min, free };
}

/**
 * Saldo driver = driver_wallets.balance (sama dengan angka "saldo" di banner app,
 * yang berasal dari GET /api/drivers/earnings).
 * Bukan tabel `wallets` (itu dompet customer).
 */

/** Buang driver yang kuota gratisnya habis DAN saldonya kurang dari minimum. */
export async function filterDriversByBalance<T extends { user_id: string }>(
    drivers: T[]
): Promise<T[]> {
    if (drivers.length === 0) return drivers;

    const { min, free } = await getDriverRules();
    console.log(
        `[eligibility] aturan: kuota gratis ${free} order | saldo minimal ${rp(min)} | kandidat ${drivers.length}`
    );

    if (min <= 0) {
        console.log('[eligibility] saldo minimal 0 → semua driver lolos');
        return drivers;
    }

    const ids = drivers.map((d) => d.user_id);
    const [dpRes, wRes] = await Promise.all([
        supabaseAdmin.from('driver_profiles').select('user_id,total_trips').in('user_id', ids),
        supabaseAdmin.from('driver_wallets').select('driver_id,balance,cash_debt').in('driver_id', ids),
    ]);

    if (dpRes.error) {
        logger.error('[eligibility] gagal ambil total_trips', { error: dpRes.error.message });
    }
    if (wRes.error) {
        logger.error('[eligibility] gagal ambil saldo driver_wallets', { error: wRes.error.message });
    }

    const trips = new Map((dpRes.data ?? []).map((r: any) => [r.user_id, Number(r.total_trips ?? 0)]));
    const bal = new Map((wRes.data ?? []).map((r: any) => [r.driver_id, Number(r.balance ?? 0)]));
    const debt = new Map((wRes.data ?? []).map((r: any) => [r.driver_id, Number(r.cash_debt ?? 0)]));

    const passed: T[] = [];
    const stat = { gratis: 0, saldoCukup: 0, ditolak: 0 };

    for (const d of drivers) {
        const t = trips.get(d.user_id) ?? 0;
        const hasWallet = bal.has(d.user_id);
        const b = bal.get(d.user_id) ?? 0;
        const cd = debt.get(d.user_id) ?? 0;
        const sisa = Math.max(free - t, 0);
        const inFreeQuota = t < free;
        const saldoOk = b >= min;

        let verdict: string;
        if (inFreeQuota) {
            verdict = 'LOLOS (kuota gratis)';
            stat.gratis++;
            passed.push(d);
        } else if (saldoOk) {
            verdict = 'LOLOS (saldo cukup)';
            stat.saldoCukup++;
            passed.push(d);
        } else {
            verdict = 'DITOLAK (kuota habis & saldo kurang)';
            stat.ditolak++;
        }

        console.log(
            `[eligibility] driver ${d.user_id} | trips: ${t}/${free} (sisa gratis: ${sisa}) | ` +
            `saldo: ${rp(b)}${hasWallet ? '' : ' (driver_wallets tidak ada)'} | utang tunai: ${rp(cd)} | ` +
            `min: ${rp(min)} | ${verdict}`
        );
    }

    console.log(
        `[eligibility] hasil: ${passed.length}/${drivers.length} lolos ` +
        `(gratis: ${stat.gratis}, saldo cukup: ${stat.saldoCukup}, ditolak: ${stat.ditolak})`
    );

    return passed;
}

/** Pengaman saat driver menekan "Terima". */
export async function assertDriverCanAccept(driverId: string) {
    const { min, free } = await getDriverRules();
    if (min <= 0) return;

    const [{ data: dp }, { data: w }] = await Promise.all([
        supabaseAdmin.from('driver_profiles').select('total_trips').eq('user_id', driverId).maybeSingle(),
        supabaseAdmin.from('driver_wallets').select('balance').eq('driver_id', driverId).maybeSingle(),
    ]);
    const trips = Number(dp?.total_trips ?? 0);
    const balance = Number(w?.balance ?? 0);

    console.log(
        `[eligibility] accept driver ${driverId} | trips: ${trips}/${free} | saldo: ${rp(balance)} | min: ${rp(min)}`
    );

    if (trips >= free && balance < min) {
        logger.warn('[eligibility] driver ditolak saat accept', { driverId, trips, free, balance, min });
        throw ApiError.forbidden(
            `Saldo minimal ${rp(min)} untuk menerima order (kuota ${free} order gratis sudah habis). ` +
            `Saldo kamu ${rp(balance)}, silakan top up.`
        );
    }
}