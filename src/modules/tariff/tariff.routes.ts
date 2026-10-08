import { Router } from 'express';
import { tariffController } from './tariff.controller';
import { requireAuth, requireRole } from '../../middleware/auth';

const router = Router();

// Publik: customer bisa lihat daftar tarif
router.get('/', tariffController.list);
router.get('/calculate', tariffController.calculate);

// Admin only
router.get('/admin/all', requireAuth, requireRole('admin'), tariffController.listAll);
router.put('/admin/:code', requireAuth, requireRole('admin'), tariffController.update);

export default router;