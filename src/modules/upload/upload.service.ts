// src/modules/upload/upload.service.ts
import { supabaseAdmin } from '../../config/supabase';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../config/logger';

type UploadType =
    | 'avatar'
    | 'merchant-logo'
    | 'merchant-cover'
    | 'product'
    | 'chat'
    | 'package-photo'
    | 'driver-document';

const BUCKET_MAP: Record<UploadType, string> = {
    'avatar': 'avatars',
    'merchant-logo': 'merchant-logos',
    'merchant-cover': 'merchant-covers',
    'product': 'product-images',
    'chat': 'chat-images',
    'package-photo': 'package-photos',
    'driver-document': 'driver-documents',
};

export const uploadService = {
    async upload(userId: string, type: UploadType, file: Express.Multer.File) {
        if (!file) throw ApiError.badRequest('File wajib diupload');

        const bucket = BUCKET_MAP[type];
        if (!bucket) throw ApiError.badRequest('Tipe upload tidak valid');

        const ext = file.mimetype.split('/')[1] || 'jpg';
        const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const filePath = `${userId}/${fileName}`;

        const { error } = await supabaseAdmin.storage
            .from(bucket)
            .upload(filePath, file.buffer, {
                contentType: file.mimetype,
                upsert: false,
            });

        if (error) {
            logger.error('Upload error', { error, userId, type, bucket });
            throw ApiError.internal('Gagal upload file');
        }

        const { data: publicUrlData } = supabaseAdmin.storage
            .from(bucket)
            .getPublicUrl(filePath);

        return {
            path: filePath,
            url: publicUrlData.publicUrl,
            bucket,
        };
    },
};