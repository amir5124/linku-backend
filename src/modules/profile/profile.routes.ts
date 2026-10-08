import { Router } from 'express';
import { profileController } from './profile.controller';
import { requireAuth } from '../../middleware/auth';
import multer from 'multer';

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // max 5 MB
    fileFilter: (_req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp'];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Format gambar tidak didukung'));
        }
    },
});


const router = Router();

router.use(requireAuth);
router.put('/me', profileController.update);
router.get('/:id', profileController.getById);
router.post(
    '/avatar',
    requireAuth,
    upload.single('image'),
    profileController.uploadAvatar
);

export default router;