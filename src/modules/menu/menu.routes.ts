import { Router } from 'express';
import { menuController } from './menu.controller';
import { requireAuth, requireRole } from '../../middleware/auth';

const router = Router();

router.get('/merchant/:merchantId', menuController.list);

router.use(requireAuth, requireRole('merchant'));
router.post('/categories', menuController.createCategory);
router.post('/items', menuController.createItem);
router.put('/items/:id', menuController.updateItem);
router.delete('/items/:id', menuController.deleteItem);

export default router;