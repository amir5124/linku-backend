// src/modules/offers/offer.routes.ts
import { NextFunction, Request, Response, Router } from 'express';
import { authenticate } from '../../middleware/auth'; // SESUAIKAN: nama file & ekspor middleware auth-mu
import { ApiError } from '../../utils/ApiError';
import * as svc from './offer.service';

const router = Router();

// SESUAIKAN: cara auth-mu menaruh user di request (salin dari order.routes.ts)
const user = (req: Request) => (req as any).user as { id: string; role?: string };

const onlyDriver = (req: Request, _res: Response, next: NextFunction) =>
    user(req)?.role === 'driver' ? next() : next(ApiError.forbidden('Hanya untuk driver'));

const wrap =
    (fn: (req: Request) => Promise<any>) =>
        async (req: Request, res: Response, next: NextFunction) => {
            try {
                res.json({ success: true, data: await fn(req) });
            } catch (err) {
                next(err);
            }
        };

// Konfigurasi (di atas route /:id)
router.get(
    '/offers/config',
    authenticate,
    wrap(async () => {
        const c = await svc.getNegoConfig();
        return { enabled: c.enabled, max_percent: c.maxPercent, step: c.step, ttl_sec: c.ttlSec };
    })
);

// ── Driver ──
router.post(
    '/:id/offers',
    authenticate,
    onlyDriver,
    wrap((req) => svc.createOffer(user(req).id, Number(req.params.id), Number(req.body?.increase)))
);
router.get(
    '/:id/offers/mine',
    authenticate,
    onlyDriver,
    wrap((req) => svc.myOffer(user(req).id, Number(req.params.id)))
);
router.delete(
    '/:id/offers/:offerId',
    authenticate,
    onlyDriver,
    wrap((req) =>
        svc.withdrawOffer(user(req).id, Number(req.params.id), Number(req.params.offerId))
    )
);

// ── Customer ──
router.get(
    '/:id/offers',
    authenticate,
    wrap((req) => svc.listOffersForCustomer(user(req).id, Number(req.params.id)))
);
router.post(
    '/:id/offers/:offerId/accept',
    authenticate,
    wrap((req) => svc.acceptOffer(user(req).id, Number(req.params.id), Number(req.params.offerId)))
);
router.post(
    '/:id/offers/:offerId/reject',
    authenticate,
    wrap((req) => svc.rejectOffer(user(req).id, Number(req.params.id), Number(req.params.offerId)))
);

export default router;