// src/modules/broadcast/broadcast.schema.ts
import { z } from 'zod';

const role = z.enum(['customer', 'driver', 'merchant']);

const audience = z
    .array(role)
    .min(1, 'Pilih minimal satu penerima')
    .max(3);

const title = z
    .string()
    .trim()
    .min(3, 'Judul minimal 3 karakter')
    .max(65, 'Judul maksimal 65 karakter');

const body = z
    .string()
    .trim()
    .min(3, 'Isi minimal 3 karakter')
    .max(240, 'Isi maksimal 240 karakter');

// Nama layar tujuan saat notifikasi diketuk (opsional), mis. "wallet", "orders".
// Hanya huruf kecil, angka, tanda hubung, garis bawah, dan garis miring.
const screen = z
    .string()
    .trim()
    .max(60)
    .regex(/^[a-z0-9/_-]+$/, 'Format layar tidak valid')
    .optional();

export const previewBroadcastSchema = z.object({
    body: z.object({ audience }),
});

export const testBroadcastSchema = z.object({
    body: z.object({ title, body, screen }),
});

export const createBroadcastSchema = z.object({
    body: z.object({ title, body, audience, screen }),
});