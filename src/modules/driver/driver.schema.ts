import { z } from 'zod';

export const updateLocationSchema = z.object({
    body: z.object({
        latitude: z
            .number()
            .min(-90, 'Latitude tidak valid')
            .max(90, 'Latitude tidak valid'),
        longitude: z
            .number()
            .min(-180, 'Longitude tidak valid')
            .max(180, 'Longitude tidak valid'),
    }),
});

export const updateStatusSchema = z.object({
    body: z.object({
        status: z.enum(['offline', 'online', 'busy']),
    }),
});

export const updateDriverSchema = z.object({
    body: z.object({
        vehicle_type: z.enum(['motor', 'mobil']).optional(),
        plate_number: z.string().trim().min(1).max(20).optional(),
        vehicle_brand: z.string().trim().min(1).max(50).optional(),
        vehicle_model: z.string().trim().min(1).max(50).optional(),
        sim_number: z.string().trim().min(1).max(30).optional(),
        ktp_number: z.string().trim().min(1).max(30).optional(),
    }),
});

export const updateServicesSchema = z.object({
    body: z.object({
        services: z
            .array(z.string())
            .min(1, 'Pilih minimal 1 layanan')
            .max(20, 'Maksimal 20 layanan'),
    }),
});