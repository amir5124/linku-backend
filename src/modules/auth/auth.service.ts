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
};