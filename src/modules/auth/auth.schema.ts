import { z } from 'zod';

const passwordRule = z.string().min(6, 'Password minimal 6 karakter').max(72, 'Password terlalu panjang');

export const forgotPasswordSchema = z.object({
    body: z.object({
        email: z.string().email('Format email tidak valid'),
    }),
});

export const resetPasswordSchema = z.object({
    body: z.object({
        email: z.string().email('Format email tidak valid'),
        code: z.string().regex(/^\d{6,10}$/, 'Kode tidak valid'),
        new_password: passwordRule,
    }),
});

export const changePasswordSchema = z.object({
    body: z.object({
        current_password: z.string().min(1, 'Password lama wajib diisi'),
        new_password: passwordRule,
    }),
});

export const registerSchema = z.object({
    body: z.object({
        email: z.string().email('Format email tidak valid'),
        password: z.string().min(6, 'Password minimal 6 karakter'),
        full_name: z.string().min(2, 'Nama minimal 2 karakter'),
        role: z.enum(['customer', 'driver', 'merchant']).default('customer'),
    }),
});

export const loginSchema = z.object({
    body: z.object({
        email: z.string().email('Format email tidak valid'),
        password: z.string().min(1, 'Password wajib diisi'),
    }),
});