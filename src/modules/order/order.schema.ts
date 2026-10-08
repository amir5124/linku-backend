// src/modules/order/order.schema.ts
import { z } from 'zod';

// ============================================================
// CREATE ORDER SCHEMA
// ============================================================
export const createOrderSchema = z
    .object({
        body: z.object({
            type: z.enum(['ride', 'food', 'send']),
            pickup_name: z.string(),
            pickup_address: z.string(),
            pickup_lat: z.number(),
            pickup_lng: z.number(),
            dropoff_name: z.string(),
            dropoff_address: z.string(),
            dropoff_lat: z.number(),
            dropoff_lng: z.number(),
            distance_km: z.number(),
            duration_min: z.number().optional(),

            // ═══════════════════════════════════════════════════
            // ✅ PAYMENT
            // ═══════════════════════════════════════════════════
            payment_method: z
                .enum(['cash', 'wallet', 'qris', 'bank_transfer'])
                .default('cash'),

            // Untuk VA transfer bank (wajib kalau bank_transfer)
            bank_code: z
                .enum([
                    'BRI',
                    'BNI',
                    'MANDIRI',
                    'BCA',
                    'PERMATA',
                    'CIMB',
                ])
                .optional(),

            // Untuk e-wallet (opsional — kalau mau support DANA/OVO via QRIS)
            ewallet_code: z
                .enum(['OVO', 'DANA', 'LINKAJA', 'GOPAY', 'SHOPEEPAY'])
                .optional(),

            notes: z.string().optional(),
            merchant_id: z.string().uuid().optional(),

            // Field tarif dari frontend
            tariff_code: z.string().optional(),
            option_name: z.string().optional(),

            items: z
                .array(
                    z.object({
                        menu_item_id: z.number(),
                        name: z.string(),
                        variant: z.string().optional(),
                        qty: z.number(),
                        price: z.number(),
                    })
                )
                .optional(),

            receiver_name: z.string().optional(),
            receiver_phone: z.string().optional(),
            sender_name: z.string().optional(),
            sender_phone: z.string().optional(),

            sender_landmark: z.string().optional(),
            receiver_landmark: z.string().optional(),

            // ⬇️ Field paket USend
            package_type: z.string().optional(),
            package_size: z.enum(['kecil', 'sedang', 'besar']).optional(),
            package_weight: z.string().optional(),
            package_protection: z.enum(['silver', 'gold']).optional(),
        }),
    })
    // ═══════════════════════════════════════════════════════════
    // ✅ VALIDASI KONDISIONAL — payment method vs bank_code
    // ═══════════════════════════════════════════════════════════
    .refine(
        (data) => {
            // bank_transfer → wajib bank_code
            if (data.body.payment_method === 'bank_transfer') {
                return !!data.body.bank_code;
            }
            return true;
        },
        {
            message: 'bank_code wajib diisi untuk metode transfer bank',
            path: ['body', 'bank_code'],
        }
    )
    // qris dengan ewallet → wajib ewallet_code (opsional, kalau dipakai)
    .refine(
        (data) => {
            // Kalau qris DAN user pilih ewallet, wajib ewallet_code
            // (opsional — kalau tidak pakai ewallet, skip)
            return true;
        },
        {
            message: 'ewallet_code tidak valid',
            path: ['body', 'ewallet_code'],
        }
    );

// ============================================================
// UPDATE STATUS SCHEMA
// ============================================================
export const updateStatusSchema = z.object({
    body: z.object({
        status: z.enum([
            'accepted',
            'arrived',
            'in_progress',
            'completed',
            'cancelled',
        ]),
        reason: z.string().optional(),
        // ⬇️ untuk validasi complete order USend
        send_code: z.string().optional(),
    }),
});