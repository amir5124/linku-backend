// src/modules/order/order.schema.ts
import { z } from 'zod';

// ============================================================
// CREATE ORDER SCHEMA
// ============================================================
export const createOrderSchema = z
    .object({
        body: z.object({
            // ride | food | send | jastip
            type: z.enum(['ride', 'food', 'send', 'jastip']),

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

            // items: food pakai menu_item_id + price,
            //        jastip pakai name + qty + est_price + variant (tanpa menu_item_id)
            items: z
                .array(
                    z.object({
                        menu_item_id: z.number().int().optional(),
                        name: z.string().max(120).optional(),
                        variant: z.string().max(200).optional(),
                        qty: z.number().int().min(1).max(99),
                        price: z.number().min(0).optional(),
                        est_price: z.number().min(0).optional(), // jastip
                    })
                )
                .optional(),

            // ===== JASTIP =====
            item_budget: z.number().positive().optional(),
            shop_note: z.string().max(300).optional(),

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
    // bank_transfer wajib bank_code
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
    )
    // jastip wajib punya items + item_budget, dan tiap item punya nama & est_price
    .refine(
        (data) => {
            if (data.body.type !== 'jastip') return true;
            const items = data.body.items ?? [];
            if (items.length === 0) return false;
            if (!(data.body.item_budget && data.body.item_budget > 0)) return false;
            return items.every(
                (it) =>
                    typeof it.name === 'string' &&
                    it.name.trim().length > 0 &&
                    typeof it.est_price === 'number' &&
                    it.est_price >= 0
            );
        },
        {
            message:
                'items (dengan name & est_price) dan item_budget wajib untuk order jastip',
            path: ['body', 'items'],
        }
    );

// ============================================================
// UPDATE STATUS SCHEMA
// 'accepted' DIHAPUS: penerimaan order hanya lewat POST /:id/accept (driver)
// dan POST /:id/merchant-accept (toko).
// ============================================================
export const updateStatusSchema = z.object({
    body: z.object({
        status: z.enum([
            'arrived',
            'purchasing', // khusus jastip: driver mulai belanja
            'in_progress',
            'completed',
            'cancelled',
        ]),
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