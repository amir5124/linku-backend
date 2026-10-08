import { Router } from 'express';
import { notificationController } from './notification.controller';
import { requireAuth } from '../../middleware/auth';
import { env } from '../../config/env';

const router = Router();

router.use(requireAuth);

router.get('/', notificationController.list);
router.put('/:id/read', notificationController.markRead);

// Endpoint test — hanya di non-production
if (env.nodeEnv !== 'production') {
    router.post('/test-self', notificationController.testSelf);
    router.post('/test-user', notificationController.testToUser);
}

export default router;