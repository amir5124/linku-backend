import dotenv from 'dotenv';
dotenv.config();

export const env = {
    port: Number(process.env.PORT || 3000),
    nodeEnv: process.env.NODE_ENV || 'development',
    supabaseUrl: process.env.SUPABASE_URL!,
    supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY!,
    jwtSecret: process.env.JWT_SECRET!,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '30d',
    expoAccessToken: process.env.EXPO_ACCESS_TOKEN || '',
    socketCorsOrigin: process.env.SOCKET_CORS_ORIGIN || '*',
};

if (!env.supabaseUrl || !env.supabaseServiceKey) {
    throw new Error('Missing Supabase env');
}