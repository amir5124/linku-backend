// src/modules/tariff/tariff.controller.ts
import { Request, Response } from 'express';
import { tariffService } from './tariff.service';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/response';
import { ApiError } from '../../utils/ApiError';

const adminId = (req: Request) => (req as any).user?.id as string | undefined;

export const tariffController = {
    // GET /api/tariffs?region_id=3  (region_id opsional; tidak valid → diabaikan)
    list: asyncHandler(async (req: Request, res: Response) => {
        const raw = req.query.region_id;
        const regionId = raw !== undefined && raw !== '' ? Number(raw) : undefined;
        return ok(res, await tariffService.list(Number.isInteger(regionId) ? regionId : undefined));
    }),

    listAll: asyncHandler(async (_req: Request, res: Response) => ok(res, await tariffService.listAll())),

    calculate: asyncHandler(async (req: Request, res: Response) => {
        const { code, distance_km } = req.query;
        if (!code || distance_km == null) {
            throw ApiError.badRequest('code dan distance_km wajib');
        }
        const result = await tariffService.calculate(String(code), Number(distance_km));
        return ok(res, result);
    }),

    create: asyncHandler(async (req: Request, res: Response) => {
        const data = await tariffService.create(req.body ?? {}, adminId(req));
        return ok(res, data, 'Tarif dibuat');
    }),

    update: asyncHandler(async (req: Request, res: Response) => {
        const data = await tariffService.update(req.params.code, req.body ?? {}, adminId(req));
        return ok(res, data, 'Tarif diupdate');
    }),

    remove: asyncHandler(async (req: Request, res: Response) => {
        await tariffService.remove(req.params.code, adminId(req));
        return ok(res, null, 'Tarif dihapus');
    }),
};