// src/modules/settings/admin.routes.ts  (dipasang di /api/admin/settings)
import { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/response';
import { settingsService } from './settings.service';

const router = Router();
router.use(requireAuth, requireRole('admin'));

const adminId = (req: any) => req.user?.id as string | undefined;

/** GET /api/admin/settings — list semua setting */
router.get('/', asyncHandler(async (_req, res) => ok(res, await settingsService.list())));

/** POST /api/admin/settings — buat setting baru */
router.post(
    '/',
    asyncHandler(async (req, res) => ok(res, await settingsService.create(req.body ?? {}, adminId(req)), 'Setting dibuat'))
);

/** PUT /api/admin/settings/:key — ubah value / value_type / category / is_public */
router.put(
    '/:key',
    asyncHandler(async (req, res) =>
        ok(res, await settingsService.update(req.params.key, req.body ?? {}, adminId(req)), 'Setting diupdate')
    )
);

/** DELETE /api/admin/settings/:key */
router.delete(
    '/:key',
    asyncHandler(async (req, res) => {
        await settingsService.remove(req.params.key, adminId(req));
        return ok(res, null, 'Setting dihapus');
    })
);

export default router;