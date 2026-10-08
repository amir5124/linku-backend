import { Request, Response } from 'express';
import { supabaseAdmin } from '../../config/supabase';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/response';

export const autobidController = {
    // GET /api/drivers/autobid
    get: asyncHandler(async (req: Request, res: Response) => {
        const { data } = await supabaseAdmin
            .from('driver_autobid')
            .select('*')
            .eq('driver_id', req.user!.id)
            .maybeSingle();

        return ok(res, data);
    }),

    // PUT /api/drivers/autobid
    update: asyncHandler(async (req: Request, res: Response) => {
        const { data, error } = await supabaseAdmin
            .from('driver_autobid')
            .upsert(
                {
                    driver_id: req.user!.id,
                    is_enabled: req.body.is_enabled ?? false,
                    max_radius_km: req.body.max_radius_km ?? 3,
                    min_fare: req.body.min_fare ?? 5000,
                    max_orders_per_hour:
                        req.body.max_orders_per_hour ?? 3,
                    services:
                        req.body.services ?? ['ride', 'send', 'food'],
                    updated_at: new Date().toISOString(),
                },
                { onConflict: 'driver_id' }
            )
            .select()
            .single();

        if (error) throw error;
        return ok(res, data, 'Autobid tersimpan');
    }),

    // GET /api/drivers/autobid/history
    history: asyncHandler(async (req: Request, res: Response) => {
        const limit = Number(req.query.limit ?? 50);

        const { data } = await supabaseAdmin
            .from('driver_autobid_log')
            .select('*')
            .eq('driver_id', req.user!.id)
            .order('created_at', { ascending: false })
            .limit(limit);

        return ok(res, data ?? []);
    }),
};