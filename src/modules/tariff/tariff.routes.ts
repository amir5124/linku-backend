// src/modules/tariff/tariff.routes.ts
import { Router } from 'express';
import { tariffController } from './tariff.controller';
import { requireAuth, requireRole } from '../../middleware/auth';

const router = Router();

// Publik: customer bisa lihat daftar tarif
router.get('/', tariffController.list);
router.get('/calculate', tariffController.calculate);

// Admin only
router.get('/admin/all', requireAuth, requireRole('admin'), tariffController.listAll);
router.post('/admin', requireAuth, requireRole('admin'), tariffController.create);
router.put('/admin/:code', requireAuth, requireRole('admin'), tariffController.update);
router.delete('/admin/:code', requireAuth, requireRole('admin'), tariffController.remove);

export default router;