import { Request, Response } from 'express';
import { profileService } from './profile.service';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/response';

export const profileController = {
    update: asyncHandler(async (req: Request, res: Response) => {
        const data = await profileService.update(req.user!.id, req.body);
        return ok(res, data, 'Profile updated');
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