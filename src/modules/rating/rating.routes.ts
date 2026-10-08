import { Router } from 'express';
import { ratingController } from './rating.controller';
import { requireAuth } from '../../middleware/auth';

const router = Router();

router.post('/', requireAuth, ratingController.submit);
router.get('/order/:orderId/mine', requireAuth, ratingController.getMine);
router.get('/order/:orderId', requireAuth, ratingController.getByOrder);
router.get('/driver/:driverId', ratingController.listByDriver);
router.get(
    '/customer/:customerId',
    requireAuth,
    ratingController.getCustomerStats
);

export default router;