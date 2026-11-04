// src/modules/region/region.routes.ts  (dipasang di /api/regions)
import { Router } from 'express';
import { regionController } from './region.controller';
import { requireAuth, requireRole } from '../../middleware/auth';

const router = Router();

// Publik: daftar kota untuk halaman "Pilih Kota"
router.get('/', regionController.list);

// Customer (harus login): kota yang dipilih
router.get('/me', requireAuth, regionController.getMine);
router.put('/me', requireAuth, regionController.setMine);

// Admin only: wilayah
router.get('/admin/all', requireAuth, requireRole('admin'), regionController.listAll);
router.post('/admin', requireAuth, requireRole('admin'), regionController.create);
router.put('/admin/:id', requireAuth, requireRole('admin'), regionController.update);
router.delete('/admin/:id', requireAuth, requireRole('admin'), regionController.remove);

// Admin only: tarif per wilayah
router.get('/admin/:id/tariffs', requireAuth, requireRole('admin'), regionController.listTariffs);
router.put('/admin/:id/tariffs/:code', requireAuth, requireRole('admin'), regionController.saveTariff);
router.delete('/admin/:id/tariffs/:code', requireAuth, requireRole('admin'), regionController.removeTariff);

export default router;