import { supabaseAdmin, createAuthClient } from '../../config/supabase';
import { ApiError } from '../../utils/ApiError';
import { signJwt } from '../../utils/jwt';
import { logger } from '../../config/logger';

export const authService = {
    async register(input: {
        email: string;
        password: string;
        full_name: string;
        role: 'customer' | 'driver' | 'merchant';
    }) {
        const email = input.email.trim().toLowerCase();

        const { data: existing } = await supabaseAdmin
            .from('profiles')
            .select('id')
            .eq('email', email)
            .maybeSingle();
        if (existing) throw ApiError.conflict('Email already registered');

        const { data: authUser, error: authErr } = await supabaseAdmin.auth.admin.createUser({
            email,
            password: input.password,
            email_confirm: true,
            user_metadata: {
                full_name: input.full_name,
                role: input.role,
                email,
            },
        });

        if (authErr || !authUser?.user) {
            logger.error('Supabase createUser failed', { error: authErr, email });
            const msg = authErr?.message || (authErr ? JSON.stringify(authErr) : 'Auth failed');
            throw ApiError.internal(msg);
        }

        const userId = authUser.user.id;

        if (input.role === 'driver') {
            // upsert: aman kalau baris sudah dibuat oleh trigger di database
            const { error: dpErr } = await supabaseAdmin
                .from('driver_profiles')
                .upsert(
                    { user_id: userId },
                    { onConflict: 'user_id', ignoreDuplicates: true }
                );
            if (dpErr) logger.error('Failed create driver_profile', { error: dpErr, userId });
        }

        if (input.role === 'merchant') {
            const { error: mpErr } = await supabaseAdmin
                .from('merchant_profiles')
                .upsert(
                    { user_id: userId, store_name: input.full_name },
                    { onConflict: 'user_id', ignoreDuplicates: true }
                );
            if (mpErr) logger.error('Failed create merchant_profile', { error: mpErr, userId });
        }

        const token = signJwt({ sub: userId, role: input.role, email });
        return { token, userId, role: input.role };
    },

    async login(email: string, password: string) {
        const normalizedEmail = email.trim().toLowerCase();

        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('id, role')
            .eq('email', normalizedEmail)
            .maybeSingle();
        if (!profile) throw ApiError.unauthorized('Email or password wrong');

        // ✅ FIX: pakai client sekali pakai, BUKAN supabaseAdmin,
        // supaya sesi user tidak menempel di client admin.
        const authClient = createAuthClient();
        const { data: signIn, error } = await authClient.auth.signInWithPassword({
            email: normalizedEmail,
            password,
        });

        if (error || !signIn?.user) {
            logger.warn('Login failed', { email: normalizedEmail, error: error?.message });
            throw ApiError.unauthorized('Email or password wrong');
        }

        const token = signJwt({
            sub: profile.id,
            role: profile.role,
            email: normalizedEmail,
        });

        return { token, userId: profile.id, role: profile.role };
    },

    async me(userId: string) {
        const { data } = await supabaseAdmin
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .maybeSingle();
        return data;
    },

    // Selalu diam-diam: jangan bocorkan apakah email terdaftar
    async forgotPassword(email: string) {
        const normalized = email.trim().toLowerCase();

        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('id, is_active')
            .eq('email', normalized)
            .maybeSingle();

        if (!profile || profile.is_active === false) return;

        const authClient = createAuthClient();
        const { error } = await authClient.auth.resetPasswordForEmail(normalized);
        if (error) {
            logger.warn('resetPasswordForEmail gagal', { email: normalized, error: error.message });
        }
    },

    async resetPassword(input: { email: string; code: string; new_password: string }) {
        const email = input.email.trim().toLowerCase();
        const invalid = () => ApiError.badRequest('Kode salah atau sudah kedaluwarsa');

        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('id, is_active')
            .eq('email', email)
            .maybeSingle();
        if (!profile || profile.is_active === false) throw invalid();

        // Verifikasi kode (sekali pakai, kedaluwarsa diatur di Supabase)
        const authClient = createAuthClient();
        const { data, error } = await authClient.auth.verifyOtp({
            email,
            token: input.code,
            type: 'recovery',
        });
        if (error || !data?.user || data.user.id !== profile.id) {
            logger.warn('Reset password: kode ditolak', { email, error: error?.message });
            throw invalid();
        }

        const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(profile.id, {
            password: input.new_password,
        });
        if (updErr) {
            logger.error('Reset password: update gagal', { userId: profile.id, error: updErr.message });
            throw ApiError.internal('Gagal mengganti password');
        }
        logger.info('Password direset', { userId: profile.id });
    },

    async changePassword(userId: string, current: string, next: string) {
        if (current === next) {
            throw ApiError.badRequest('Password baru harus berbeda dari password lama');
        }

        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('id, email')
            .eq('id', userId)
            .maybeSingle();
        if (!profile?.email) throw ApiError.notFound('Akun tidak ditemukan');

        // Verifikasi password lama
        const authClient = createAuthClient();
        const { error } = await authClient.auth.signInWithPassword({
            email: profile.email,
            password: current,
        });
        // 400, BUKAN 401: app Anda menganggap 401 sebagai sesi habis lalu logout otomatis
        if (error) throw ApiError.badRequest('Password lama salah');

        const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(userId, {
            password: next,
        });
        if (updErr) {
            logger.error('Ganti password gagal', { userId, error: updErr.message });
            throw ApiError.internal('Gagal mengganti password');
        }
        logger.info('Password diganti', { userId });
    },
};