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
            // String kosong = hapus token (dikirim aplikasi versi lama saat logout)
            const t = typeof patch.fcm_token === 'string' ? patch.fcm_token.trim() : '';
            clean.fcm_token = t || null;
        }

        if (Object.keys(clean).length === 0) {
            throw ApiError.badRequest('No fields to update');
        }

        // ============================================================
        // TOKEN PUSH PER PERANGKAT (tabel push_tokens)
        // profiles.fcm_token tetap diisi sebagai "token perangkat terakhir"
        // supaya kode lama yang masih membacanya tidak langsung mati.
        // ============================================================
        if (patch.fcm_token !== undefined) {
            if (clean.fcm_token) {
                // Simpan token perangkat ini. Primary key = token, jadi kalau
                // perangkat ini sebelumnya milik akun lain, kepemilikannya
                // otomatis pindah ke akun ini.
                const { error: tokErr } = await supabaseAdmin
                    .from('push_tokens')
                    .upsert(
                        {
                            token: clean.fcm_token,
                            user_id: userId,
                            last_seen_at: new Date().toISOString(),
                        },
                        { onConflict: 'token' }
                    );
                if (tokErr) {
                    logger.warn('Gagal simpan push token', {
                        userId,
                        error: tokErr.message,
                    });
                }

                // Kolom lama profiles.fcm_token: satu token hanya boleh dimiliki
                // satu akun (masih dibaca kode lama, mis. edge function).
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
            } else {
                // Aplikasi versi lama mengosongkan token saat logout tanpa
                // menyebut token yang mana. Hapus token perangkat terakhir
                // akun ini dari push_tokens supaya perangkat yang sudah logout
                // tidak terus menerima notifikasi. Aplikasi versi baru memakai
                // removePushToken() dan tidak lewat jalur ini.
                const { data: cur } = await supabaseAdmin
                    .from('profiles')
                    .select('fcm_token')
                    .eq('id', userId)
                    .maybeSingle();
                if (cur?.fcm_token) {
                    const { error: delErr } = await supabaseAdmin
                        .from('push_tokens')
                        .delete()
                        .eq('token', cur.fcm_token)
                        .eq('user_id', userId);
                    if (delErr) {
                        logger.warn('Gagal hapus push token (jalur lama)', {
                            userId,
                            error: delErr.message,
                        });
                    }
                }
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

    /**
     * Hapus token push milik SATU perangkat (dipanggil saat logout).
     * Perangkat lain milik akun yang sama tidak terpengaruh.
     */
    async removePushToken(userId: string, token: string) {
        const { error } = await supabaseAdmin
            .from('push_tokens')
            .delete()
            .eq('token', token)
            .eq('user_id', userId);
        if (error) throw ApiError.internal(error.message);

        // Kolom lama: kosongkan hanya kalau isinya token perangkat ini
        const { error: legacyErr } = await supabaseAdmin
            .from('profiles')
            .update({ fcm_token: null })
            .eq('id', userId)
            .eq('fcm_token', token);
        if (legacyErr) {
            logger.warn('Gagal kosongkan profiles.fcm_token', {
                userId,
                error: legacyErr.message,
            });
        }
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