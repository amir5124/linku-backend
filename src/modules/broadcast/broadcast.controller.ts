// src/modules/broadcast/broadcast.controller.ts
import { Request, Response } from 'express';
import { broadcastService } from './broadcast.service';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok, created } from '../../utils/response';

export const broadcastController = {
    preview: asyncHandler(async (req: Request, res: Response) =>
        ok(res, await broadcastService.preview(req.body.audience))
    ),

    test: asyncHandler(async (req: Request, res: Response) =>
        ok(
            res,
            await broadcastService.test(req.user!.id, req.body),
            'Notifikasi tes dikirim ke akunmu'
        )
    ),

    create: asyncHandler(async (req: Request, res: Response) =>
        created(
            res,
            await broadcastService.create(req.user!.id, req.body),
            'Broadcast sedang dikirim'
        )
    ),

    list: asyncHandler(async (_req: Request, res: Response) =>
        ok(res, await broadcastService.list())
    ),

    detail: asyncHandler(async (req: Request, res: Response) =>
        ok(res, await broadcastService.detail(Number(req.params.id)))
    ),
};