// src/modules/chat/chat.routes.ts
import { Router } from 'express';
import multer from 'multer';
import { chatController } from './chat.controller';
import { requireAuth } from '../../middleware/auth';

const upload = multer({
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

const router = Router();

router.use(requireAuth);

// ============================================================
// ROOMS
// ============================================================
// 🆕 List semua room milik user (untuk tab Pesan)
router.get('/rooms', chatController.listRooms);

// Buka / buat room untuk order tertentu
router.post('/rooms/order/:orderId', chatController.openRoom);

// ============================================================
// MESSAGES
// ============================================================
router.get('/rooms/:roomId/messages', chatController.listMessages);
router.post('/rooms/:roomId/messages', chatController.sendMessage);
router.put('/rooms/:roomId/read', chatController.markRead);
router.post(
    '/rooms/:roomId/images',
    upload.single('image'),
    chatController.uploadImage
);

// ============================================================
// UNREAD
// ============================================================
router.get('/order/:orderId/unread', chatController.unreadByOrder);

export default router;