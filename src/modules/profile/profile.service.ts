import { supabaseAdmin } from '../../config/supabase';
import { ApiError } from '../../utils/ApiError';

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
        if (patch.fcm_token !== undefined) clean.fcm_token = patch.fcm_token;

        if (Object.keys(clean).length === 0) {
            throw ApiError.badRequest('No fields to update');
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