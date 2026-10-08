import { Router } from 'express';
import { adminController } from './admin.controller';
import { requireAuth, requireRole } from '../../middleware/auth';

const router = Router();
router.use(requireAuth, requireRole('admin'));

router.get('/users', adminController.listUsers);
router.put('/drivers/:id/verify', adminController.verifyDriver);
router.put('/merchants/:id/verify', adminController.verifyMerchant);
router.get('/stats', adminController.stats);

export default router;