// src/modules/settings/settings.routes.ts
import { Router } from 'express';
import { supabaseAdmin } from '../../config/supabase';

const router = Router();

/**
 * GET /api/settings/public
 * Return setting yang is_public = TRUE saja.
 * Publik — tidak perlu auth.
 */
router.get('/public', async (_req, res, next) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('app_settings')
            .select('key, value, value_type')
            .eq('is_public', true);

        if (error) throw error;

        // Convert value ke tipe yang sesuai
        const settings: Record<string, any> = {};
        for (const row of data ?? []) {
            switch (row.value_type) {
                case 'number':
                    settings[row.key] = Number(row.value);
                    break;
                case 'boolean':
                    settings[row.key] = row.value === 'true';
                    break;
                case 'json':
                    try { settings[row.key] = JSON.parse(row.value); }
                    catch { settings[row.key] = row.value; }
                    break;
                default:
                    settings[row.key] = row.value;
            }
        }

        res.json({ success: true, data: settings });
    } catch (err) {
        next(err);
    }
});

export default router;