// src/modules/upload/upload.routes.ts
import { Router } from 'express';
import multer from 'multer';
import { uploadController } from './upload.controller';
import { requireAuth } from '../../middleware/auth';

const router = Router();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // max 5 MB
    fileFilter: (_req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
            return cb(new Error('Hanya file gambar yang diizinkan'));
        }
        cb(null, true);
    },
});

router.use(requireAuth);

// POST /api/upload/:type
// type: avatar | merchant-logo | merchant-cover | product | chat | package-photo | driver-document
router.post('/:type', upload.single('image'), uploadController.upload);

export default router;