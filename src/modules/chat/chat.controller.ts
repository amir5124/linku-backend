// src/modules/chat/chat.controller.ts
import { Request, Response } from 'express';
import { chatService } from './chat.service';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok, created } from '../../utils/response';
import { ApiError } from '../../utils/ApiError';

export const chatController = {
    // ============================================================
    // ROOMS
    // ============================================================
    openRoom: asyncHandler(async (req: Request, res: Response) => {
        const data = await chatService.getOrCreateRoom(
            Number(req.params.orderId),
            req.user!.id
        );
        return ok(res, data);
    }),

    // 🆕 List semua room milik user
    listRooms: asyncHandler(async (req: Request, res: Response) => {
        const limit = Math.min(Number(req.query.limit ?? 50), 100);
        const data = await chatService.listRooms(req.user!.id, limit);
        return ok(res, data);
    }),

    // ============================================================
    // MESSAGES
    // ============================================================
    listMessages: asyncHandler(async (req: Request, res: Response) => {
        const limit = Math.min(Number(req.query.limit ?? 100), 200);
        const data = await chatService.listMessages(
            Number(req.params.roomId),
            req.user!.id,
            limit
        );
        return ok(res, data);
    }),

    sendMessage: asyncHandler(async (req: Request, res: Response) => {
        const { message, type } = req.body;
        if (!message && type !== 'image') {
            throw ApiError.badRequest('Pesan tidak boleh kosong');
        }

        const data = await chatService.sendMessage(
            Number(req.params.roomId),
            req.user!.id,
            message ?? '',
            type ?? 'text'
        );
        return created(res, data, 'Pesan terkirim');
    }),

    markRead: asyncHandler(async (req: Request, res: Response) => {
        await chatService.markRead(
            Number(req.params.roomId),
            req.user!.id
        );
        return ok(res, null, 'Pesan ditandai sudah dibaca');
    }),

    // ============================================================
    // IMAGE
    // ============================================================
    uploadImage: asyncHandler(async (req: Request, res: Response) => {
        if (!req.file) {
            throw ApiError.badRequest('File tidak ditemukan');
        }

        const data = await chatService.uploadImage(
            Number(req.params.roomId),
            req.user!.id,
            {
                buffer: req.file.buffer,
                mimetype: req.file.mimetype,
                originalname: req.file.originalname,
            }
        );

        return created(res, data, 'Gambar terkirim');
    }),

    // ============================================================
    // UNREAD
    // ============================================================
    unreadByOrder: asyncHandler(async (req: Request, res: Response) => {
        const data = await chatService.unreadCountByOrder(
            Number(req.params.orderId),
            req.user!.id
        );
        return ok(res, data);
    }),
};