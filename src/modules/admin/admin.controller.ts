import { Request, Response } from 'express';
import { supabaseAdmin } from '../../config/supabase';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/response';

export const adminController = {
    listUsers: asyncHandler(async (req: Request, res: Response) => {
        const role = req.query.role as string | undefined;
        let q = supabaseAdmin.from('profiles').select('*').order('created_at', { ascending: false });
        if (role) q = q.eq('role', role);
        const { data } = await q;
        return ok(res, data);
    }),

    verifyDriver: asyncHandler(async (req: Request, res: Response) => {
        await supabaseAdmin
            .from('driver_profiles')
            .update({ is_verified: true })
            .eq('user_id', req.params.id);
        return ok(res, null, 'Driver verified');
    }),

    verifyMerchant: asyncHandler(async (req: Request, res: Response) => {
        await supabaseAdmin
            .from('merchant_profiles')
            .update({ is_verified: true })
            .eq('user_id', req.params.id);
        return ok(res, null, 'Merchant verified');
    }),

    stats: asyncHandler(async (_req: Request, res: Response) => {
        const [{ count: users }, { count: drivers }, { count: merchants }, { count: orders }] =
            await Promise.all([
                supabaseAdmin.from('profiles').select('*', { count: 'exact', head: true }),
                supabaseAdmin.from('profiles').select('*', { count: 'exact', head: true }).eq('role', 'driver'),
                supabaseAdmin.from('profiles').select('*', { count: 'exact', head: true }).eq('role', 'merchant'),
                supabaseAdmin.from('orders').select('*', { count: 'exact', head: true }),
            ]);
        return ok(res, { users, drivers, merchants, orders });
    }),
};