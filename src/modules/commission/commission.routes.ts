// src/modules/commission/commission.routes.ts  (dipasang di /api/admin/commission-rates)
import { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/response';
import { commissionService } from './commission.service';

const router = Router();
router.use(requireAuth, requireRole('admin'));

const adminId = (req: any) => req.user?.id as string | undefined;

/** GET /api/admin/commission-rates */
router.get('/', asyncHandler(async (_req, res) => ok(res, await commissionService.list())));

/** POST /api/admin/commission-rates   body: { order_type, tariff_code?, rate, is_active? } */
router.post(
    '/',
    asyncHandler(async (req, res) => ok(res, await commissionService.create(req.body ?? {}, adminId(req)), 'Komisi dibuat'))
);

/** PUT /api/admin/commission-rates/:orderType/:tariff   (tariff = kode tarif, atau _default untuk default jenis order) */
router.put(
    '/:orderType/:tariff',
    asyncHandler(async (req, res) =>
        ok(
            res,
            await commissionService.update(req.params.orderType, req.params.tariff, req.body ?? {}, adminId(req)),
            'Komisi diupdate'
        )
    )
);

/** DELETE /api/admin/commission-rates/:orderType/:tariff */
router.delete(
    '/:orderType/:tariff',
    asyncHandler(async (req, res) => {
        await commissionService.remove(req.params.orderType, req.params.tariff, adminId(req));
        return ok(res, null, 'Komisi dihapus');
    })
);

export default router;