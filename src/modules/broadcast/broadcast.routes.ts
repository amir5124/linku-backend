// src/modules/broadcast/broadcast.routes.ts
import { Router } from 'express';
import { broadcastController } from './broadcast.controller';
import { requireAuth, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import {
    createBroadcastSchema,
    previewBroadcastSchema,
    testBroadcastSchema,
} from './broadcast.schema';

const router = Router();

// Semua endpoint broadcast hanya untuk admin
router.use(requireAuth, requireRole('admin'));

router.post('/preview', validate(previewBroadcastSchema), broadcastController.preview);
router.post('/test', validate(testBroadcastSchema), broadcastController.test);
router.post('/', validate(createBroadcastSchema), broadcastController.create);
router.get('/', broadcastController.list);
router.get('/:id', broadcastController.detail);

export default router;