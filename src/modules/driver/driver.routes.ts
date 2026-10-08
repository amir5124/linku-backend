import { Router } from 'express';
import { driverController } from './driver.controller';
import { requireAuth, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { autobidController } from './autobid.controller';
import {
    updateLocationSchema,
    updateStatusSchema,
    updateDriverSchema,
    updateServicesSchema,
} from './driver.schema';
import multer from 'multer';

const router = Router();

const uploadDocs = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp'];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Format gambar tidak didukung'));
        }
    },
});

// ============================================================
// Endpoint PUBLIK
// ============================================================
router.get('/nearby', driverController.nearby);

// ============================================================
// AUTO BID (driver only) — ✅ FIX
// ============================================================
router.use('/autobid', requireAuth, requireRole('driver'));

router.get('/autobid', autobidController.get);
router.put('/autobid', autobidController.update);
router.get('/autobid/history', autobidController.history);

// ============================================================
// Endpoint DRIVER ONLY
// ============================================================
router.get(
    '/profile',
    requireAuth,
    requireRole('driver'),
    driverController.getProfile
);

router.put(
    '/profile',
    requireAuth,
    requireRole('driver'),
    validate(updateDriverSchema),
    driverController.updateProfile
);

router.put(
    '/services',
    requireAuth,
    requireRole('driver'),
    validate(updateServicesSchema),
    driverController.updateServices
);

router.put(
    '/location',
    requireAuth,
    requireRole('driver'),
    validate(updateLocationSchema),
    driverController.updateLocation
);

router.put(
    '/status',
    requireAuth,
    requireRole('driver'),
    validate(updateStatusSchema),
    driverController.setStatus
);

router.get(
    '/earnings',
    requireAuth,
    requireRole('driver'),
    driverController.getEarnings
);

router.get(
    '/earnings/history',
    requireAuth,
    requireRole('driver'),
    driverController.getEarningsHistory
);

router.post(
    '/verification',
    requireAuth,
    requireRole('driver'),
    uploadDocs.fields([
        { name: 'ktp', maxCount: 1 },
        { name: 'sim', maxCount: 1 },
        { name: 'stnk', maxCount: 1 },
        { name: 'selfie', maxCount: 1 },
    ]),
    driverController.submitVerification
);

router.get(
    '/verification',
    requireAuth,
    requireRole('driver'),
    driverController.getVerification
);

export default router;