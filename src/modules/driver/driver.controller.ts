import { Request, Response } from 'express';
import { driverService } from './driver.service';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/response';
import { ApiError } from '../../utils/ApiError';

export const driverController = {
    updateLocation: asyncHandler(async (req: Request, res: Response) => {
        const { latitude, longitude } = req.body;
        await driverService.updateLocation(req.user!.id, latitude, longitude);
        return ok(res, null, 'Location updated');
    }),

    setStatus: asyncHandler(async (req: Request, res: Response) => {
        await driverService.setStatus(req.user!.id, req.body.status);
        return ok(res, null, 'Status updated');
    }),

    updateProfile: asyncHandler(async (req: Request, res: Response) => {
        const data = await driverService.updateProfile(
            req.user!.id,
            req.body
        );
        return ok(res, data);
    }),

    updateServices: asyncHandler(async (req: Request, res: Response) => {
        const data = await driverService.updateServices(
            req.user!.id,
            req.body.services
        );
        return ok(res, data, 'Layanan diperbarui');
    }),

    getEarnings: asyncHandler(async (req: Request, res: Response) => {
        const data = await driverService.getEarnings(req.user!.id);
        return ok(res, data);
    }),

    getEarningsHistory: asyncHandler(async (req: Request, res: Response) => {
        const limit = Math.min(Number(req.query.limit ?? 50), 100);
        const offset = Math.max(Number(req.query.offset ?? 0), 0);

        const data = await driverService.getEarningsHistory(
            req.user!.id,
            limit,
            offset
        );
        return ok(res, data);
    }),

    getProfile: asyncHandler(async (req: Request, res: Response) => {
        const data = await driverService.getProfile(req.user!.id);
        return ok(res, data);
    }),

    nearby: asyncHandler(async (req: Request, res: Response) => {
        const lat = Number(req.query.lat);
        const lng = Number(req.query.lng);
        const radius = Math.min(Number(req.query.radius ?? 5000), 50000);
        const limit = Math.min(Number(req.query.limit ?? 50), 100);

        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            throw ApiError.badRequest('Query lat dan lng wajib diisi');
        }

        const data = await driverService.nearbyDrivers(
            lat,
            lng,
            radius,
            limit
        );
        return ok(res, data);
    }),

    submitVerification: asyncHandler(async (req: Request, res: Response) => {
        const { ktp_number, sim_number, sim_type, stnk_number, plate_number } =
            req.body;

        if (!ktp_number || !sim_number || !stnk_number || !plate_number) {
            throw ApiError.badRequest(
                'Nomor KTP, SIM, STNK, dan plat nomor wajib diisi'
            );
        }

        const files = req.files as {
            ktp?: Express.Multer.File[];
            sim?: Express.Multer.File[];
            stnk?: Express.Multer.File[];
            selfie?: Express.Multer.File[];
        };

        const data = await driverService.submitVerification(
            req.user!.id,
            {
                ktpNumber: ktp_number,
                simNumber: sim_number,
                simType: sim_type,
                stnkNumber: stnk_number,
                plateNumber: plate_number,
            },
            {
                ktp: files?.ktp?.[0],
                sim: files?.sim?.[0],
                stnk: files?.stnk?.[0],
                selfie: files?.selfie?.[0],
            }
        );

        return ok(res, data, 'Dokumen verifikasi dikirim');
    }),
    
    getVerification: asyncHandler(async (req: Request, res: Response) => {
        const data = await driverService.getVerification(req.user!.id);
        return ok(res, data);
    }),
};