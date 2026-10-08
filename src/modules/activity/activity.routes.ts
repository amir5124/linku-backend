// src/modules/activity/activity.routes.ts
import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { activityController } from './activity.controller';

const router = Router();

router.post('/ping', authenticate, activityController.ping);
router.post('/quote', authenticate, activityController.quote);

export default router;