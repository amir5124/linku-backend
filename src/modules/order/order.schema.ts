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

            // ✅ PAYMENT
            payment_method: z
                .enum(['cash', 'wallet', 'qris', 'bank_transfer'])
                .default('cash'),

            bank_code: z
                .enum(['BRI', 'BNI', 'MANDIRI', 'BCA', 'PERMATA', 'CIMB'])
                .optional(),

            ewallet_code: z
                .enum(['OVO', 'DANA', 'LINKAJA', 'GOPAY', 'SHOPEEPAY'])
                .optional(),

            notes: z.string().optional(),
            merchant_id: z.string().uuid().optional(),

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

            package_type: z.string().optional(),
            package_size: z.enum(['kecil', 'sedang', 'besar']).optional(),
            package_weight: z.string().optional(),
            package_protection: z.enum(['silver', 'gold']).optional(),
        }),
    })
    .refine(
        (data) => {
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
    // food wajib punya merchant_id dan minimal 1 item
    .refine(
        (data) =>
            data.body.type !== 'food' ||
            (!!data.body.merchant_id && (data.body.items?.length ?? 0) > 0),
        {
            message: 'merchant_id dan items wajib untuk order makanan',
            path: ['body', 'merchant_id'],
        }
    );

// ============================================================
// UPDATE STATUS SCHEMA
// 'accepted' DIHAPUS: penerimaan order hanya lewat POST /:id/accept (driver)
// dan POST /:id/merchant-accept (toko).
// ============================================================
export const updateStatusSchema = z.object({
    body: z.object({
        status: z.enum(['arrived', 'in_progress', 'completed', 'cancelled']),
        reason: z.string().optional(),
        send_code: z.string().optional(),
    }),
});

// ============================================================
// RESPONS MERCHANT
// ============================================================
export const merchantAcceptSchema = z.object({
    body: z.object({
        prep_minutes: z.number().int().min(1).max(180).optional(),
    }),
});

export const merchantRejectSchema = z.object({
    body: z.object({
        reason: z.string().max(200).optional(),
    }),
});