import { Request, Response } from 'express';
import { tariffService } from './tariff.service';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/response';
import { ApiError } from '../../utils/ApiError';

export const tariffController = {
    list: asyncHandler(async (_req: Request, res: Response) =>
        ok(res, await tariffService.list())
    ),

    listAll: asyncHandler(async (_req: Request, res: Response) =>
        ok(res, await tariffService.listAll())
    ),

    calculate: asyncHandler(async (req: Request, res: Response) => {
        const { code, distance_km } = req.query;
        if (!code || distance_km == null) {
            throw ApiError.badRequest('code dan distance_km wajib');
        }
        const result = await tariffService.calculate(
            String(code),
            Number(distance_km)
        );
        return ok(res, result);
    }),

    update: asyncHandler(async (req: Request, res: Response) => {
        const data = await tariffService.update(req.params.code, req.body);
        return ok(res, data, 'Tarif diupdate');
    }),
};