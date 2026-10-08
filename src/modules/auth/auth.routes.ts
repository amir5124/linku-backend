import { Router } from 'express';
import { authController } from './auth.controller';
import { validate } from '../../middleware/validate';
import { registerSchema, loginSchema } from './auth.schema';
import { authLimiter } from '../../middleware/rateLimit';
import { requireAuth } from '../../middleware/auth';

const router = Router();

router.post('/register', authLimiter, validate(registerSchema), authController.register);
router.post('/login', authLimiter, validate(loginSchema), authController.login);
router.get('/me', requireAuth, authController.me);

export default router;