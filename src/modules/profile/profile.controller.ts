import { Request, Response } from 'express';
import { profileService } from './profile.service';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { ok } from '../../utils/response';

export const profileController = {
    update: asyncHandler(async (req: Request, res: Response) => {
        const data = await profileService.update(req.user!.id, req.body);
        return ok(res, data, 'Profile updated');
    }),

    // Dipanggil aplikasi saat logout: hapus token push perangkat ini saja
    removePushToken: asyncHandler(async (req: Request, res: Response) => {
        const token =
            typeof req.body?.token === 'string' ? req.body.token.trim() : '';
        if (!token) {
            throw ApiError.badRequest('Token wajib diisi');
        }
        await profileService.removePushToken(req.user!.id, token);
        return ok(res, null, 'Push token dihapus');
    }),

    uploadAvatar: asyncHandler(async (req: Request, res: Response) => {
        if (!req.file) {
            throw new Error('File tidak ditemukan');
        }
        const data = await profileService.uploadAvatar(
            req.user!.id,
            req.file
        );
        return ok(res, data, 'Avatar berhasil diunggah');
    }),

    getById: asyncHandler(async (req: Request, res: Response) => {
        const data = await profileService.getById(req.params.id);
        return ok(res, data);
    }),
};