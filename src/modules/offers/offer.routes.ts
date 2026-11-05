// src/modules/offers/offer.routes.ts
import { NextFunction, Request, Response, Router } from 'express';
import { authenticate, requireRole } from '../../middleware/auth'; // SESUAIKAN
import * as svc from './offer.service';

const router = Router();
const uid = (req: Request) => (req as any).user.id as string; // SESUAIKAN: sumber id user dari JWT

const h =
    (fn: (req: Request) => Promise<any>) =>
        async (req: Request, res: Response, _next: NextFunction) => {
            try {
                res.json({ success: true, data: await fn(req) });
            } catch (e: any) {
                const status = e instanceof svc.OfferError ? e.status : 500;
                if (status === 500) console.error('[OFFER]', e);
                res.status(status).json({
                    success: false,
                    message: status === 500 ? 'Terjadi kesalahan server.' : e.message,
                });
            }
        };

// Konfigurasi (harus di atas route /:id)
router.get('/offers/config', authenticate, h(async () => {
    const c = await svc.getNegoConfig();
    return { enabled: c.enabled, max_percent: c.maxPercent, step: c.step, ttl_sec: c.ttlSec };
}));

// Driver
router.post('/:id/offers', authenticate, requireRole('driver'),
    h((req) => svc.createOffer(uid(req), Number(req.params.id), Number(req.body?.increase))));
router.get('/:id/offers/mine', authenticate, requireRole('driver'),
    h((req) => svc.myOffer(uid(req), Number(req.params.id))));
router.delete('/:id/offers/:offerId', authenticate, requireRole('driver'),
    h((req) => svc.withdrawOffer(uid(req), Number(req.params.id), Number(req.params.offerId))));

// Customer
router.get('/:id/offers', authenticate,
    h((req) => svc.listOffersForCustomer(uid(req), Number(req.params.id))));
router.post('/:id/offers/:offerId/accept', authenticate,
    h((req) => svc.acceptOffer(uid(req), Number(req.params.id), Number(req.params.offerId))));
router.post('/:id/offers/:offerId/reject', authenticate,
    h((req) => svc.rejectOffer(uid(req), Number(req.params.id), Number(req.params.offerId))));

export default router;