import { Request, Response } from 'express';
import { notificationService } from './notification.service';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/response';

export const notificationController = {
    list: asyncHandler(async (req: Request, res: Response) =>
        ok(res, await notificationService.list(req.user!.id))
    ),

    markRead: asyncHandler(async (req: Request, res: Response) => {
        await notificationService.markRead(req.user!.id, Number(req.params.id));
        return ok(res, null, 'Marked read');
    }),

    /**
     * Endpoint TEST — kirim notifikasi ke diri sendiri.
     * Hanya aktif kalau NODE_ENV != production.
     */
    testSelf: asyncHandler(async (req: Request, res: Response) => {
        await notificationService.sendToUser(req.user!.id, {
            title: '🔔 Test Notifikasi',
            body: `Halo! Ini notif test dari backend pada ${new Date().toLocaleTimeString('id-ID')}`,
            data: { type: 'test' },
        });
        return ok(res, null, 'Test notification sent');
    }),

    /**
     * Endpoint TEST — kirim ke userId tertentu (untuk admin/dev).
     */
    testToUser: asyncHandler(async (req: Request, res: Response) => {
        const { userId, title, body } = req.body;
        await notificationService.sendToUser(userId, {
            title: title || '🔔 Test dari Backend',
            body: body || 'Push notification berhasil dikirim dari Express',
            data: { type: 'test' },
        });
        return ok(res, null, 'Test notification sent');
    }),
};