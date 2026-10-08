import { Router } from 'express';
import { savedAddressController } from './saved-address.controller';
import { requireAuth } from '../../middleware/auth';

const router = Router();
router.use(requireAuth);

router.get('/', savedAddressController.list);
router.post('/', savedAddressController.upsert);
router.get('/:kind', savedAddressController.get);
router.delete('/:kind', savedAddressController.remove);

export default router;