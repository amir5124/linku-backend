import { supabaseAdmin } from '../../config/supabase';
import { ApiError } from '../../utils/ApiError';

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

/** Buang driver yang kuota gratisnya habis DAN saldonya kurang dari minimum. */
export async function filterDriversByBalance<T extends { user_id: string }>(
    drivers: T[]
): Promise<T[]> {
    if (drivers.length === 0) return drivers;
    const { min, free } = await getDriverRules();
    if (min <= 0) return drivers;

    const ids = drivers.map((d) => d.user_id);
    const [{ data: dps }, { data: ws }] = await Promise.all([
        supabaseAdmin.from('driver_profiles').select('user_id,total_trips').in('user_id', ids),
        supabaseAdmin.from('wallets').select('user_id,balance').in('user_id', ids),
    ]);
    const trips = new Map((dps ?? []).map((r: any) => [r.user_id, Number(r.total_trips ?? 0)]));
    const bal = new Map((ws ?? []).map((r: any) => [r.user_id, Number(r.balance ?? 0)]));

    return drivers.filter((d) => {
        const inFreeQuota = (trips.get(d.user_id) ?? 0) < free;
        return inFreeQuota || (bal.get(d.user_id) ?? 0) >= min;
    });
}

/** Pengaman saat driver menekan "Terima". */
export async function assertDriverCanAccept(driverId: string) {
    const { min, free } = await getDriverRules();
    if (min <= 0) return;

    const [{ data: dp }, { data: w }] = await Promise.all([
        supabaseAdmin.from('driver_profiles').select('total_trips').eq('user_id', driverId).maybeSingle(),
        supabaseAdmin.from('wallets').select('balance').eq('user_id', driverId).maybeSingle(),
    ]);
    const trips = Number(dp?.total_trips ?? 0);
    const balance = Number(w?.balance ?? 0);

    if (trips >= free && balance < min) {
        throw ApiError.forbidden(
            `Saldo minimal ${rp(min)} untuk menerima order (kuota ${free} order gratis sudah habis). ` +
            `Saldo kamu ${rp(balance)}, silakan top up.`
        );
    }
}