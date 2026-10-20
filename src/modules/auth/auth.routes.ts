import { Router } from 'express';
import { authController } from './auth.controller';
import { validate } from '../../middleware/validate';
import {
    registerSchema, loginSchema,
    forgotPasswordSchema, resetPasswordSchema, changePasswordSchema,
} from './auth.schema';
import { authLimiter } from '../../middleware/rateLimit';
import { requireAuth } from '../../middleware/auth';

const router = Router();

router.post('/register', authLimiter, validate(registerSchema), authController.register);
router.post('/login', authLimiter, validate(loginSchema), authController.login);
router.get('/me', requireAuth, authController.me);
router.post('/forgot-password', authLimiter, validate(forgotPasswordSchema), authController.forgotPassword);
router.post('/reset-password', authLimiter, validate(resetPasswordSchema), authController.resetPassword);
router.put('/change-password', requireAuth, authLimiter, validate(changePasswordSchema), authController.changePassword);

export default router;