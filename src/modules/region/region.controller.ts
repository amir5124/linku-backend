// src/modules/region/region.controller.ts
import { Request, Response } from 'express';
import { regionService } from './region.service';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/response';
import { ApiError } from '../../utils/ApiError';

const adminId = (req: Request) => (req as any).user?.id as string | undefined;

const idParam = (req: Request): number => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest('ID wilayah tidak valid');
    return id;
};

export const regionController = {
    // ── Publik / customer ──
    list: asyncHandler(async (_req: Request, res: Response) => ok(res, await regionService.listPublic())),

    getMine: asyncHandler(async (req: Request, res: Response) =>
        ok(res, await regionService.getMine(req.user!.id))
    ),

    setMine: asyncHandler(async (req: Request, res: Response) => {
        const regionId = req.body?.region_id;
        if (regionId === undefined) throw ApiError.badRequest('region_id wajib');
        const data = await regionService.setMine(req.user!.id, regionId);
        return ok(res, data, 'Kota disimpan');
    }),

    // ── Admin: wilayah ──
    listAll: asyncHandler(async (_req: Request, res: Response) => ok(res, await regionService.listAll())),

    create: asyncHandler(async (req: Request, res: Response) => {
        const data = await regionService.create(req.body ?? {}, adminId(req));
        return ok(res, data, 'Wilayah dibuat');
    }),

    update: asyncHandler(async (req: Request, res: Response) => {
        const data = await regionService.update(idParam(req), req.body ?? {}, adminId(req));
        return ok(res, data, 'Wilayah diupdate');
    }),

    remove: asyncHandler(async (req: Request, res: Response) => {
        await regionService.remove(idParam(req), adminId(req));
        return ok(res, null, 'Wilayah dihapus');
    }),

    // ── Admin: tarif per wilayah ──
    listTariffs: asyncHandler(async (req: Request, res: Response) =>
        ok(res, await regionService.listTariffs(idParam(req)))
    ),

    saveTariff: asyncHandler(async (req: Request, res: Response) => {
        const data = await regionService.saveTariff(
            idParam(req),
            String(req.params.code),
            req.body ?? {},
            adminId(req)
        );
        return ok(res, data, 'Tarif wilayah disimpan');
    }),

    removeTariff: asyncHandler(async (req: Request, res: Response) => {
        await regionService.removeTariff(idParam(req), String(req.params.code), adminId(req));
        return ok(res, null, 'Tarif wilayah dihapus');
    }),
};