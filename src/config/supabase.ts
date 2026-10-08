import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { env } from './env';

// Service role client (bypass RLS), hanya dipakai backend untuk query data.
// JANGAN dipakai untuk signIn / signUp / verifyOtp / setSession,
// karena sesi user akan menempel dan RLS jadi berlaku.
export const supabaseAdmin = createClient(env.supabaseUrl, env.supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as any },
});

// Anon client, untuk verifikasi token user (auth.getUser(token))
export const supabaseAnon = createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as any },
});

// Client sekali pakai untuk login/OTP. Buat baru setiap operasi,
// jangan disimpan di variabel global.
export const createAuthClient = () =>
    createClient(env.supabaseUrl, env.supabaseAnonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
        realtime: { transport: ws as any },
    });