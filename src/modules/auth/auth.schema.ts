import { z } from 'zod';

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