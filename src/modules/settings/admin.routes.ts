// src/modules/settings/admin.routes.ts
import { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth';
import { supabaseAdmin } from '../../config/supabase';

const router = Router();

/**
 * GET /api/admin/settings — list semua setting
 */
router.get('/', requireAuth, requireRole('admin'), async (_req, res, next) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('app_settings')
            .select('*')
            .order('category', { ascending: true })
            .order('key', { ascending: true });

        if (error) throw error;
        res.json({ success: true, data });
    } catch (err) { next(err); }
});

/**
 * PUT /api/admin/settings/:key — update 1 setting
 */
router.put('/:key', requireAuth, requireRole('admin'), async (req, res, next) => {
    try {
        const { key } = req.params;
        const { value } = req.body;
        const adminId = req.user!.id;

        if (value === undefined || value === null) {
            return res.status(400).json({
                success: false,
                message: 'value wajib diisi',
            });
        }

        const { data, error } = await supabaseAdmin
            .from('app_settings')
            .update({
                value: String(value),
                updated_by: adminId,
            })
            .eq('key', key)
            .select()
            .single();

        if (error) throw error;
        if (!data) {
            return res.status(404).json({
                success: false,
                message: 'Setting tidak ditemukan',
            });
        }

        res.json({ success: true, data });
    } catch (err) { next(err); }
});

export default router;