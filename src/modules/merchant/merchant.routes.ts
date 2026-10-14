// src/modules/merchant/merchant.routes.ts
import { Router } from 'express';
import { merchantController } from './merchant.controller';
import { requireAuth, requireRole } from '../../middleware/auth';

const router = Router();

// Semua endpoint butuh login
router.use(requireAuth);

const merchantOnly = requireRole('merchant');

// Path tetap (tanpa parameter): aman di mana saja
router.get('/nearby', merchantController.findNearby);

// ===== KHUSUS MERCHANT — harus SEBELUM '/:id' =====
// STORE
router.post('/store', merchantOnly, merchantController.upsertStore);
router.get('/store', merchantOnly, merchantController.getMyStore);
router.put('/store/open', merchantOnly, merchantController.setOpen);

// CATEGORIES
router.get('/categories', merchantOnly, merchantController.listCategories);
router.post('/categories', merchantOnly, merchantController.addCategory);
router.delete('/categories/:id', merchantOnly, merchantController.deleteCategory);

// MENU ITEMS
router.get('/menu', merchantOnly, merchantController.listMenu);
router.post('/menu', merchantOnly, merchantController.addMenuItem);
router.put('/menu/:id', merchantOnly, merchantController.updateMenuItem);
router.put('/menu/:id/toggle', merchantOnly, merchantController.toggleMenuAvailability);
router.delete('/menu/:id', merchantOnly, merchantController.deleteMenuItem);

// ===== PUBLIK DENGAN PARAMETER — paling akhir =====
router.get('/:id/menu', merchantController.getPublicMenu);
router.get('/:id', merchantController.getPublicProfile);

export default router;