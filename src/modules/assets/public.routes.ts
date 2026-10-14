// src/modules/assets/public.routes.ts
// 🌐 PUBLIC routes only (tanpa auth)
import { Router } from 'express';
import { assetsController } from './assets.controller';

const router = Router();

// GET /api/public/assets?category=banner&limit=10
router.get('/assets', assetsController.listPublic);

export default router;