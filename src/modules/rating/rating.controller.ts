import { Request, Response } from 'express';
import { ratingService } from './rating.service';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok, created } from '../../utils/response';
import { ApiError } from '../../utils/ApiError';

export const ratingController = {
    submit: asyncHandler(async (req: Request, res: Response) => {
        const { orderId, rating, comment, tags } = req.body;

        if (!orderId || !rating) {
            throw ApiError.badRequest('orderId dan rating wajib');
        }

        const ratingNum = Number(rating);
        if (!Number.isFinite(ratingNum) || ratingNum < 1 || ratingNum > 5) {
            throw ApiError.badRequest('rating harus antara 1 sampai 5');
        }

        const data = await ratingService.submit({
            orderId: Number(orderId),
            reviewerId: req.user!.id,
            rating: ratingNum,
            comment,
            tags,
        });

        return created(res, data, 'Rating tersimpan');
    }),

    getByOrder: asyncHandler(async (req: Request, res: Response) => {
        const data = await ratingService.getByOrder(
            Number(req.params.orderId)
        );
        return ok(res, data);
    }),

    getMine: asyncHandler(async (req: Request, res: Response) => {
        const data = await ratingService.getMine(
            Number(req.params.orderId),
            req.user!.id
        );
        return ok(res, data);
    }),

    listByDriver: asyncHandler(async (req: Request, res: Response) => {
        const data = await ratingService.listByDriver(
            req.params.driverId
        );
        return ok(res, data);
    }),

    getCustomerStats: asyncHandler(async (req: Request, res: Response) => {
        const data = await ratingService.getCustomerStats(
            req.params.customerId
        );

        if (!data) throw ApiError.notFound('Customer tidak ditemukan');

        return ok(res, data);
    }),
};