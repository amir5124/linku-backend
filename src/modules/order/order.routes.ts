import { Router } from 'express';
import { orderController } from './order.controller';
import { requireAuth, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { createOrderSchema, updateStatusSchema } from './order.schema';
import multer from 'multer';




const router = Router();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // max 5MB
    fileFilter: (_req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp'];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Format gambar tidak didukung'));
        }
    },
});

router.use(requireAuth);

router.post('/', requireRole('customer'), validate(createOrderSchema), orderController.create);
router.post('/:id/accept', requireRole('driver'), orderController.accept);
router.put('/:id/status', validate(updateStatusSchema), orderController.updateStatus);
router.get('/:id', orderController.detail);
router.get('/', orderController.list);
router.post(
    '/:id/photo',
    requireRole('driver'),
    upload.single('photo'),
    orderController.uploadPackagePhoto
);

export default router;