// src/modules/upload/upload.controller.ts
import { Request, Response } from 'express';
import { uploadService } from './upload.service';
import { asyncHandler } from '../../utils/asyncHandler';
import { created } from '../../utils/response';
import { ApiError } from '../../utils/ApiError';

export const uploadController = {
    upload: asyncHandler(async (req: Request, res: Response) => {
        const { type } = req.params;
        if (!req.file) throw ApiError.badRequest('File wajib diupload');

        const data = await uploadService.upload(
            req.user!.id,
            type as any,
            req.file
        );
        return created(res, data, 'Upload berhasil');
    }),
};