import { supabaseAdmin } from '../../config/supabase';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../config/logger';

export const profileService = {
    async update(
        userId: string,
        patch: {
            full_name?: string;
            phone?: string;
            email?: string;
            avatar_url?: string;
            fcm_token?: string;
        }
    ) {
        const clean: Record<string, any> = {};

        if (patch.full_name !== undefined) clean.full_name = patch.full_name;

        if (patch.phone !== undefined) {
            // Normalisasi ke E.164
            const cleaned = patch.phone.replace(/[\s\-()]/g, '');
            if (cleaned.startsWith('+')) clean.phone = cleaned;
            else if (cleaned.startsWith('62')) clean.phone = '+' + cleaned;
            else if (cleaned.startsWith('0')) clean.phone = '+62' + cleaned.slice(1);
            else if (cleaned.startsWith('8')) clean.phone = '+62' + cleaned;
            else clean.phone = cleaned;
        }

        if (patch.email !== undefined) clean.email = patch.email.trim().toLowerCase();
        if (patch.avatar_url !== undefined) clean.avatar_url = patch.avatar_url;

        if (patch.fcm_token !== undefined) {
            // String kosong = hapus token (dikirim aplikasi saat logout)
            const t = typeof patch.fcm_token === 'string' ? patch.fcm_token.trim() : '';
            clean.fcm_token = t || null;
        }

        if (Object.keys(clean).length === 0) {
            throw ApiError.badRequest('No fields to update');
        }

        // Satu token push hanya boleh dimiliki satu akun. Kalau perangkat ini
        // sebelumnya dipakai akun lain (dan logout-nya gagal membersihkan token),
        // lepaskan token dari akun lama supaya notifikasi tidak salah alamat.
        if (clean.fcm_token) {
            const { error: dedupeErr } = await supabaseAdmin
                .from('profiles')
                .update({ fcm_token: null })
                .eq('fcm_token', clean.fcm_token)
                .neq('id', userId);
            if (dedupeErr) {
                logger.warn('Gagal melepas fcm_token dari akun lain', {
                    userId,
                    error: dedupeErr.message,
                });
            }
        }

        const { data, error } = await supabaseAdmin
            .from('profiles')
            .update(clean)
            .eq('id', userId)
            .select()
            .single();

        if (error) throw ApiError.internal(error.message);
        return data;
    },

    async getById(userId: string) {
        const { data } = await supabaseAdmin
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .single();
        return data;
    },

    async uploadAvatar(userId: string, file: Express.Multer.File) {
        // 1. Upload ke Supabase Storage
        const ext = file.originalname.split('.').pop() ?? 'jpg';
        const fileName = `${userId}-${Date.now()}.${ext}`;

        const { data: upload, error: uploadErr } = await supabaseAdmin.storage
            .from('avatars')
            .upload(fileName, file.buffer, {
                contentType: file.mimetype,
                upsert: true,
            });

        if (uploadErr) {
            throw new Error(uploadErr.message);
        }

        // 2. Ambil public URL
        const { data: urlData } = supabaseAdmin.storage
            .from('avatars')
            .getPublicUrl(fileName);

        const avatarUrl = urlData.publicUrl;

        // 3. Update profiles.avatar_url
        const { error: updateErr } = await supabaseAdmin
            .from('profiles')
            .update({ avatar_url: avatarUrl })
            .eq('id', userId);

        if (updateErr) {
            throw new Error(updateErr.message);
        }

        return { avatar_url: avatarUrl };
    },
};