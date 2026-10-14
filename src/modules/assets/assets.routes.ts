// src/modules/assets/assets.routes.ts
// 🔒 ADMIN routes only
import { Router } from 'express';
import multer from 'multer';
import { requireAuth, requireRole } from '../../middleware/auth';
import { assetsController } from './assets.controller';

const router = Router();

// Multer
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024,
        files: 20,
    },
    fileFilter: (_req, file, cb) => {
        const allowed = [
            'image/png',
            'image/jpeg',
            'image/jpg',
            'image/webp',
            'image/svg+xml',
            'image/gif',
        ];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error(`Tipe file tidak didukung: ${file.mimetype}`));
        }
    },
});

// ⚠️ Semua route di bawah ini butuh admin
router.use(requireAuth, requireRole('admin'));

// ❌ HAPUS baris ini:
// router.get('/public/assets', assetsController.listPublic);

router.get('/', assetsController.list);
router.get('/stats', assetsController.stats);
router.get('/:id', assetsController.getById);
router.post('/', upload.single('file'), assetsController.upload);
router.post('/bulk', upload.array('files', 20), assetsController.bulkUpload);
router.put('/:id', assetsController.update);
router.put('/:id/replace', upload.single('file'), assetsController.replaceFile);
router.delete('/:id', assetsController.remove);

export default router;