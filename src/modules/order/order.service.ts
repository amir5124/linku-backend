// modules/order/order.service.ts
import { supabaseAdmin } from '../../config/supabase';
import { ApiError } from '../../utils/ApiError';
import { matchingService } from './matching.service';
import { notificationService } from '../notification/notification.service';
import { merchantWalletService } from '../wallet/merchant-wallet.service';
import { logger } from '../../config/logger';

import {
    kindOf,
    newOrderForDriver,
    driverFoundForCustomer,
    searchingForCustomer,
    statusNotif,
} from './order-notification.copy';

// ============================================================
// Helpers
// ============================================================

type Coords = { latitude: number; longitude: number };

const generateOrderCode = () =>
    'GR' + Date.now().toString().slice(-10) + Math.floor(Math.random() * 1000);

// 'accepted' di sini hanya dicapai lewat accept() / autobid / admin.
const VALID_STATUS_TRANSITIONS: Record<string, string[]> = {
    pending: ['accepted', 'cancelled'],
    accepted: ['arrived', 'cancelled'],
    arrived: ['in_progress', 'cancelled'],
    in_progress: ['completed', 'cancelled'],
    completed: [],
    cancelled: [],
};

function parseEwkbHex(hex: string): Coords | null {
    if (!hex || typeof hex !== 'string') return null;
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length < 50) return null;

    try {
        const little = hex.slice(0, 2) === '01';
        const lngHex = hex.slice(18, 34);
        const latHex = hex.slice(34, 50);

        const hexToDouble = (h: string) => {
            const bytes = new Uint8Array(8);
            for (let i = 0; i < 8; i++) {
                const idx = little ? i : 7 - i;
                bytes[idx] = parseInt(h.substr(i * 2, 2), 16);
            }
            return new DataView(bytes.buffer).getFloat64(0, true);
        };

        const longitude = hexToDouble(lngHex);
        const latitude = hexToDouble(latHex);

        if (
            Number.isFinite(latitude) &&
            Number.isFinite(longitude) &&
            !(latitude === 0 && longitude === 0)
        ) {
            return { latitude, longitude };
        }
    } catch (err) {
        console.warn('[parseEwkbHex] gagal:', err);
    }
    return null;
}

function parseLocation(loc: any): Coords | null {
    if (!loc) return null;

    if (typeof loc === 'string') {
        const hex = parseEwkbHex(loc);
        if (hex) return hex;

        const m = loc.match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i);
        if (m) {
            return { latitude: Number(m[2]), longitude: Number(m[1]) };
        }
        return null;
    }

    if (Array.isArray(loc?.coordinates) && loc.coordinates.length >= 2) {
        const [lng, lat] = loc.coordinates;
        if (typeof lat === 'number' && typeof lng === 'number') {
            return { latitude: lat, longitude: lng };
        }
    }

    if (typeof loc.latitude === 'number' && typeof loc.longitude === 'number') {
        return { latitude: loc.latitude, longitude: loc.longitude };
    }

    return null;
}

function firstName(full: string | null | undefined): string {
    if (!full) return 'Driver';
    return full.trim().split(/\s+/)[0] || 'Driver';
}

function prettyPlace(name: string | null | undefined): string {
    if (!name) return 'lokasimu';
    const parts = name.split(',').map((s) => s.trim());
    const cleaned = parts.filter(
        (p) => p && !/^[A-Z0-9]{4,8}\+[A-Z0-9]+$/i.test(p)
    );
    return cleaned[0] ?? name;
}

function haversineKm(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number
): number {
    const R = 6371;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

const rp = (n: number) => `Rp${Number(n).toLocaleString('id-ID')}`;

// ============================================================
// ✅ [BARU] HELPER: Validasi toko buka & verified
// Dipakai di create() & merchantRespond() supaya order yang
// masuk ke toko yang sedang TUTUP selalu ditolak di server,
// bukan cuma di UI aplikasi.
// ============================================================
async function assertMerchantOpen(
    merchantId: string,
    context: string
): Promise<{ store_name: string }> {
    const { data: merchant, error } = await supabaseAdmin
        .from('merchant_profiles')
        .select('user_id, store_name, is_open, is_verified')
        .eq('user_id', merchantId)
        .maybeSingle();

    if (error) {
        logger.error(`[${context}] Gagal cek merchant`, {
            error: error.message,
            merchantId,
        });
        throw ApiError.internal('Gagal memvalidasi toko');
    }

    if (!merchant) {
        throw ApiError.badRequest('Toko tidak ditemukan');
    }

    if (merchant.is_verified === false) {
        logger.warn(`[${context}] Toko belum verified`, { merchantId });
        throw ApiError.badRequest('Toko belum terverifikasi');
    }

    if (merchant.is_open !== true) {
        logger.warn(`[${context}] Toko sedang tutup`, {
            merchantId,
            storeName: merchant.store_name,
        });
        throw ApiError.badRequest(
            `Toko "${merchant.store_name}" sedang tutup. Silakan pilih toko lain atau coba lagi nanti.`
        );
    }

    return { store_name: merchant.store_name };
}

type OrderItemInput = {
    menu_item_id: number;
    name: string;
    variant: string | null;
    qty: number;
    price: number;
};

// ============================================================
// Service
// ============================================================

export const orderService = {
    // ============================================================
    // CREATE ORDER
    // ============================================================
    async create(customerId: string, input: any) {
        logger.info('[order.create] Mulai', {
            customerId,
            type: input.type,
            tariffCode: input.tariff_code,
            paymentMethod: input.payment_method,
        });

        const reportedKm = Number(input.distance_km);
        const straightKm = haversineKm(
            Number(input.pickup_lat),
            Number(input.pickup_lng),
            Number(input.dropoff_lat),
            Number(input.dropoff_lng)
        );
        const safeReportedKm = Number.isFinite(reportedKm) ? reportedKm : 0;
        const safeStraightKm = Number.isFinite(straightKm) ? straightKm : 0;
        const distanceKm =
            Math.round(Math.max(safeReportedKm, safeStraightKm) * 1000) / 1000;

        if (!(distanceKm > 0)) {
            throw ApiError.badRequest('Jarak perjalanan tidak valid');
        }
        if (safeReportedKm + 0.1 < safeStraightKm) {
            logger.warn(
                '[order.create] distance_km dari klien lebih kecil dari jarak garis lurus, dikoreksi',
                {
                    customerId,
                    reportedKm: safeReportedKm,
                    straightKm: safeStraightKm,
                    usedKm: distanceKm,
                }
            );
        }

        let delivery_fee = 0;
        let admin_fee = 0;
        let driver_earning = 0;
        let platform_earning = 0;
        let tariffCode: string | null = null;
        let tariffLabel: string | null = null;

        if (input.tariff_code) {
            const { data: t, error: tErr } = await supabaseAdmin.rpc(
                'calculate_tariff',
                {
                    p_code: input.tariff_code,
                    p_distance_km: distanceKm,
                }
            );

            if (tErr) {
                logger.error('[order.create] calculate_tariff gagal', {
                    error: tErr.message,
                    code: input.tariff_code,
                });
                throw ApiError.internal(tErr.message);
            }

            const row = Array.isArray(t) ? t[0] : t;
            if (!row) {
                throw ApiError.badRequest(
                    `Tarif "${input.tariff_code}" tidak ditemukan`
                );
            }

            delivery_fee = row.price ?? 0;
            admin_fee = 0;
            driver_earning = delivery_fee;
            platform_earning = 0;
            tariffCode = row.code ?? input.tariff_code;
            tariffLabel = row.label ?? input.option_name ?? null;
        } else {
            const { data: fare, error: fErr } = await supabaseAdmin.rpc(
                'calculate_fare',
                {
                    p_distance_km: distanceKm,
                    p_type: input.type,
                    p_is_peak_hour: false,
                }
            );

            if (fErr) {
                logger.error('[order.create] calculate_fare gagal', {
                    error: fErr.message,
                    type: input.type,
                });
                throw ApiError.internal(fErr.message);
            }

            const fareRow = Array.isArray(fare) ? fare[0] : fare;
            if (!fareRow || !(Number(fareRow.delivery_fee) > 0)) {
                throw ApiError.badRequest('Tarif tidak dapat dihitung');
            }

            delivery_fee = Number(fareRow.delivery_fee);
            admin_fee = 0;
            driver_earning = delivery_fee;
            platform_earning = 0;
        }

        logger.info('[order.create] Tarif dihitung', {
            delivery_fee,
            admin_fee,
            driver_earning,
            platform_earning,
            distanceKm,
        });

        let subtotal = 0;
        let packaging_fee = 0;
        let validatedItems: OrderItemInput[] = [];

        if (input.type === 'food') {
            if (!input.merchant_id) {
                throw ApiError.badRequest('merchant_id wajib untuk order makanan');
            }
            if (!Array.isArray(input.items) || input.items.length === 0) {
                throw ApiError.badRequest('Item pesanan wajib diisi');
            }

            // ============================================================
            // ✅ [BARU] VALIDASI: toko buka & verified
            // ============================================================
            await assertMerchantOpen(String(input.merchant_id), 'order.create');

            const ids: number[] = Array.from(
                new Set<number>(input.items.map((i: any) => Number(i.menu_item_id)))
            );
            if (ids.some((id) => !Number.isFinite(id))) {
                throw ApiError.badRequest('Item pesanan tidak valid');
            }

            const { data: menuRows, error: menuErr } = await supabaseAdmin
                .from('menu_items')
                .select('id, merchant_id, name, price, is_available')
                .in('id', ids)
                .eq('merchant_id', input.merchant_id);

            if (menuErr) {
                logger.error('[order.create] Gagal ambil menu', {
                    error: menuErr.message,
                    merchantId: input.merchant_id,
                });
                throw ApiError.internal('Gagal memvalidasi menu');
            }

            const menuById = new Map<number, any>(
                (menuRows ?? []).map((m: any) => [Number(m.id), m])
            );

            validatedItems = input.items.map((i: any): OrderItemInput => {
                const m = menuById.get(Number(i.menu_item_id));
                const qty = Math.floor(Number(i.qty));

                if (!m) {
                    throw ApiError.badRequest(
                        'Ada menu yang tidak tersedia di toko ini'
                    );
                }
                if (m.is_available === false) {
                    throw ApiError.badRequest(
                        `Menu "${m.name}" sedang tidak tersedia`
                    );
                }
                if (!(qty > 0)) {
                    throw ApiError.badRequest('Jumlah item tidak valid');
                }

                return {
                    menu_item_id: Number(m.id),
                    name: m.name,
                    variant: i.variant ?? null,
                    qty,
                    price: Number(m.price),
                };
            });

            subtotal = validatedItems.reduce((s, i) => s + i.qty * i.price, 0);
            packaging_fee = 0;
        } else if (input.items?.length) {
            validatedItems = input.items.map((i: any): OrderItemInput => ({
                menu_item_id: i.menu_item_id,
                name: i.name,
                variant: i.variant ?? null,
                qty: i.qty,
                price: i.price,
            }));
            subtotal = validatedItems.reduce((s, i) => s + i.qty * i.price, 0);
            packaging_fee = 0;
        }

        const total_fare = subtotal + delivery_fee + packaging_fee;

        const paymentMethod = input.payment_method ?? 'cash';

        if (paymentMethod === 'bank_transfer' && !input.bank_code) {
            throw ApiError.badRequest(
                'bank_code wajib diisi untuk metode transfer bank'
            );
        }

        if (input.type === 'food' && paymentMethod === 'cash') {
            try {
                const elig = await merchantWalletService.getEligibility(
                    String(input.merchant_id)
                );
                if (!elig.can_accept_cash_orders) {
                    logger.warn('[order.create] Toko melewati batas utang, cash ditolak', {
                        merchantId: input.merchant_id,
                    });
                    throw ApiError.badRequest(
                        'Toko sedang tidak dapat menerima pesanan tunai. Silakan pilih pembayaran non-tunai.'
                    );
                }
            } catch (err: any) {
                if (err instanceof ApiError) throw err;
                logger.error('[order.create] Cek eligibility merchant gagal', {
                    merchantId: input.merchant_id,
                    error: err?.message ?? err,
                });
            }
        }

        if (paymentMethod === 'wallet') {
            const { data: customerWallet } = await supabaseAdmin
                .from('wallets')
                .select('balance')
                .eq('user_id', customerId)
                .maybeSingle();

            const balance = Number(customerWallet?.balance ?? 0);
            if (balance < total_fare) {
                throw ApiError.badRequest(
                    `Saldo tidak cukup. Butuh ${rp(total_fare)}, saldo: ${rp(balance)}`
                );
            }
        }

        let sendCode: string | null = null;
        if (input.type === 'send') {
            const { data: codeData, error: codeErr } = await supabaseAdmin.rpc(
                'generate_send_code'
            );
            if (codeErr) {
                logger.error('[order.create] Gagal generate send_code', {
                    error: codeErr.message,
                });
                sendCode =
                    'WS' + Math.random().toString(36).slice(2, 10).toUpperCase();
            } else {
                sendCode = codeData as string;
            }
            logger.info('[order.create] send_code', { sendCode });
        }

        const { data: setting } = await supabaseAdmin
            .from('settings')
            .select('value')
            .eq('key', 'order_accept_duration_sec')
            .maybeSingle();

        const acceptDurationSec = Number(setting?.value ?? 30);

        const acceptExpiresAt = new Date(
            Date.now() + acceptDurationSec * 1000
        ).toISOString();

        logger.info('[order.create] accept_expires_at', {
            acceptDurationSec,
            acceptExpiresAt,
        });

        const { data: order, error } = await supabaseAdmin
            .from('orders')
            .insert({
                order_code: generateOrderCode(),
                type: input.type,
                customer_id: customerId,
                merchant_id: input.merchant_id || null,
                pickup_name: input.pickup_name,
                pickup_address: input.pickup_address,
                pickup_location: `POINT(${input.pickup_lng} ${input.pickup_lat})`,
                dropoff_name: input.dropoff_name,
                dropoff_address: input.dropoff_address,
                dropoff_location: `POINT(${input.dropoff_lng} ${input.dropoff_lat})`,
                distance_km: distanceKm,
                duration_min: input.duration_min,
                subtotal,
                delivery_fee,
                packaging_fee,
                admin_fee,
                total_fare,
                driver_earning,
                merchant_earning: subtotal,
                platform_earning,
                payment_method: paymentMethod,
                payment_status: 'pending',
                notes: input.notes,
                receiver_name: input.receiver_name,
                receiver_phone: input.receiver_phone,
                sender_name: input.sender_name ?? null,
                sender_phone: input.sender_phone,
                tariff_code: tariffCode,
                option_name: tariffLabel,
                send_code: sendCode,
                status: 'pending',

                accept_expires_at: acceptExpiresAt,

                sender_landmark: input.sender_landmark ?? null,
                receiver_landmark: input.receiver_landmark ?? null,

                package_type: input.package_type ?? null,
                package_size: input.package_size ?? null,
                package_weight: input.package_weight ?? null,
                package_protection: input.package_protection ?? 'silver',
            })
            .select()
            .single();

        if (error || !order) {
            logger.error('[order.create] Insert gagal', {
                error: error?.message,
            });
            throw ApiError.internal(error?.message || 'Failed create order');
        }

        logger.info('[order.create] Order created', {
            id: order.id,
            order_code: order.order_code,
            type: order.type,
            tariff_code: order.tariff_code,
            delivery_fee: order.delivery_fee,
            payment_method: paymentMethod,
            send_code: order.send_code,
        });

        if (validatedItems.length) {
            const { error: itemsErr } = await supabaseAdmin
                .from('order_items')
                .insert(
                    validatedItems.map((i) => ({
                        order_id: order.id,
                        menu_item_id: i.menu_item_id,
                        name: i.name,
                        variant: i.variant,
                        qty: i.qty,
                        price: i.price,
                        subtotal: i.qty * i.price,
                    }))
                );

            if (itemsErr) {
                logger.warn('[order.create] Gagal insert items', {
                    error: itemsErr.message,
                    orderId: order.id,
                });
            }
        }

        // ═══════════════════════════════════════════════════════════
        // HANDLE PAYMENT
        // ═══════════════════════════════════════════════════════════
        if (paymentMethod === 'cash') {
            logger.info('[order.create] Payment: CASH', {
                orderId: order.id,
                amount: total_fare,
            });
        } else if (paymentMethod === 'wallet') {
            logger.info('[order.create] Payment: WALLET', {
                orderId: order.id,
                customerId,
                amount: total_fare,
            });

            try {
                const { walletService } = await import('../wallet/wallet.service');

                const result = await walletService.payWithWallet(
                    customerId,
                    order.id,
                    total_fare
                );

                await supabaseAdmin
                    .from('orders')
                    .update({
                        payment_status: 'paid',
                        paid_at: new Date().toISOString(),
                        payment_reference: `WALLET-${order.id}`,
                    })
                    .eq('id', order.id);

                logger.info('[order.create] ✅ Wallet paid', {
                    orderId: order.id,
                    amount: total_fare,
                    newBalance: result.new_balance,
                });
            } catch (err: any) {
                logger.error('[order.create] ❌ Wallet payment gagal', {
                    orderId: order.id,
                    error: err.message,
                });

                await supabaseAdmin
                    .from('orders')
                    .update({
                        status: 'cancelled',
                        cancelled_at: new Date().toISOString(),
                        cancellation_reason: `Payment wallet gagal: ${err.message}`,
                    })
                    .eq('id', order.id);

                throw ApiError.internal('Gagal potong saldo: ' + err.message);
            }
        } else if (
            paymentMethod === 'qris' ||
            paymentMethod === 'bank_transfer'
        ) {
            logger.info('[order.create] Payment: LINKQU', {
                orderId: order.id,
                method: paymentMethod,
                amount: total_fare,
                bankCode: input.bank_code,
            });

            try {
                const { walletService } = await import('../wallet/wallet.service');

                const payment = await walletService.createOrderPayment({
                    orderId: order.id,
                    userId: customerId,
                    amount: total_fare,
                    method: paymentMethod === 'qris' ? 'qris' : 'va',
                    bankCode: input.bank_code,
                });

                await supabaseAdmin
                    .from('orders')
                    .update({
                        payment_status: 'pending',
                        payment_reference: payment.partner_reff,
                        payment_url: payment.qr_url ?? payment.va_number,
                        payment_expired_at: payment.expired_at,
                    })
                    .eq('id', order.id);

                logger.info('[order.create] ✅ Payment link created', {
                    orderId: order.id,
                    method: paymentMethod,
                    reference: payment.partner_reff,
                });

                return await orderService.getById(order.id, customerId, 'customer');
            } catch (err: any) {
                logger.error('[order.create] ❌ Payment link gagal', {
                    orderId: order.id,
                    error: err.message,
                });

                await supabaseAdmin
                    .from('orders')
                    .update({
                        status: 'cancelled',
                        cancelled_at: new Date().toISOString(),
                        cancellation_reason: `Payment link gagal: ${err.message}`,
                    })
                    .eq('id', order.id);

                throw ApiError.internal('Gagal buat payment: ' + err.message);
            }
        }

        await orderService.onOrderReady(order, {
            pickup: {
                latitude: Number(input.pickup_lat),
                longitude: Number(input.pickup_lng),
            },
            dropoff: {
                latitude: Number(input.dropoff_lat),
                longitude: Number(input.dropoff_lng),
            },
        });

        return await orderService.getById(order.id, customerId, 'customer');
    },

    // ============================================================
    // ORDER SIAP (pembayaran beres)
    // ============================================================
    async onOrderReady(
        order: any,
        hint: { pickup?: Coords; dropoff?: Coords } = {}
    ) {
        if (order.type === 'food' && order.merchant_id) {
            const { data: claimed } = await supabaseAdmin
                .from('orders')
                .update({
                    merchant_status: 'waiting',
                    merchant_notified_at: new Date().toISOString(),
                })
                .eq('id', order.id)
                .eq('status', 'pending')
                .is('merchant_status', null)
                .select('id')
                .maybeSingle();

            if (!claimed) {
                logger.info('[order.onReady] Toko sudah pernah dikabari, skip', {
                    orderId: order.id,
                });
                return;
            }

            await orderService.notifyMerchantNewOrder(order);
            return;
        }

        await orderService.dispatchToDrivers(order.id, hint);
    },

    // ============================================================
    // NOTIF: pesanan baru → TOKO
    // ============================================================
    async notifyMerchantNewOrder(order: any) {
        const { data: items } = await supabaseAdmin
            .from('order_items')
            .select('qty')
            .eq('order_id', order.id);

        const count = (items ?? []).reduce(
            (s: number, i: any) => s + Number(i.qty),
            0
        );

        try {
            await notificationService.sendToUser(order.merchant_id, {
                title: 'Pesanan baru masuk 🔔',
                body: `${count} item · ${rp(order.subtotal)} · Segera konfirmasi`,
                data: {
                    order_id: String(order.id),
                    order_code: order.order_code,
                    type: 'merchant_new_order',
                    service: 'food',
                },
            });
        } catch (err: any) {
            logger.warn('[order] Gagal notif merchant', {
                orderId: order.id,
                err: err.message,
            });
        }

        try {
            await notificationService.sendToUser(order.customer_id, {
                title: 'Menunggu konfirmasi toko',
                body: 'Pesananmu sudah diteruskan ke toko.',
                data: {
                    order_id: String(order.id),
                    type: 'waiting_merchant',
                    service: 'food',
                },
            });
        } catch {
            /* abaikan */
        }
    },

    // ============================================================
    // RESPONS TOKO (terima / tolak)
    // ============================================================
    async merchantRespond(
        orderId: number,
        merchantId: string,
        accept: boolean,
        opts: { prep_minutes?: number; reason?: string } = {}
    ) {
        const { data: order } = await supabaseAdmin
            .from('orders')
            .select('*')
            .eq('id', orderId)
            .single();

        if (!order) throw ApiError.notFound('Order not found');
        if (order.merchant_id !== merchantId) throw ApiError.forbidden();
        if (order.status !== 'pending' || order.merchant_status !== 'waiting') {
            throw ApiError.conflict('Pesanan sudah direspons');
        }

        // ============================================================
        // ✅ [BARU] VALIDASI: toko masih buka saat terima pesanan
        // (mencegah toko terima order padahal sudah tutup)
        // ============================================================
        if (accept) {
            await assertMerchantOpen(merchantId, 'order.merchantRespond');
        }

        const now = new Date().toISOString();
        const patch: any = accept
            ? {
                merchant_status: 'accepted',
                merchant_responded_at: now,
                prep_minutes: opts.prep_minutes ?? null,
            }
            : {
                merchant_status: 'rejected',
                merchant_responded_at: now,
                status: 'cancelled',
                cancelled_at: now,
                cancellation_reason: opts.reason ?? 'Ditolak toko',
            };

        const { data: updated } = await supabaseAdmin
            .from('orders')
            .update(patch)
            .eq('id', orderId)
            .eq('status', 'pending')
            .eq('merchant_status', 'waiting')
            .select()
            .maybeSingle();

        if (!updated) throw ApiError.conflict('Pesanan sudah direspons');

        logger.info('[order.merchantRespond]', {
            orderId,
            merchantId,
            accept,
            prep: opts.prep_minutes,
        });

        if (accept) {
            await notificationService
                .sendToUser(order.customer_id, {
                    title: 'Pesanan diterima toko ✅',
                    body: opts.prep_minutes
                        ? `Estimasi disiapkan ±${opts.prep_minutes} menit. Sedang mencarikan driver.`
                        : 'Sedang mencarikan driver untukmu.',
                    data: {
                        order_id: String(orderId),
                        type: 'merchant_accepted',
                        service: 'food',
                    },
                })
                .catch(() => { });

            await orderService.dispatchToDrivers(orderId);
        } else {
            orderService.flagRefundIfPaid(updated);

            await notificationService
                .sendToUser(order.customer_id, {
                    title: 'Pesanan ditolak toko',
                    body: opts.reason ?? 'Toko tidak dapat memproses pesananmu saat ini.',
                    data: {
                        order_id: String(orderId),
                        type: 'order_cancelled',
                        service: 'food',
                    },
                })
                .catch(() => { });
        }

        return updated;
    },

    async merchantMarkReady(orderId: number, merchantId: string) {
        const ALLOWED = ['pending', 'accepted', 'arrived'];

        const { data: order } = await supabaseAdmin
            .from('orders')
            .select('*')
            .eq('id', orderId)
            .single();

        if (!order) throw ApiError.notFound('Order not found');
        if (order.merchant_id !== merchantId) throw ApiError.forbidden();
        if (order.type !== 'food' || order.merchant_status !== 'accepted') {
            throw ApiError.badRequest('Pesanan belum diterima toko');
        }
        if (!ALLOWED.includes(order.status)) {
            throw ApiError.conflict('Pesanan sudah diambil driver atau selesai');
        }
        if (order.merchant_ready_at) return order;

        const { data: updated } = await supabaseAdmin
            .from('orders')
            .update({ merchant_ready_at: new Date().toISOString() })
            .eq('id', orderId)
            .is('merchant_ready_at', null)
            .in('status', ALLOWED)
            .select()
            .maybeSingle();

        if (!updated) throw ApiError.conflict('Status pesanan sudah berubah, muat ulang');

        const { data: store } = await supabaseAdmin
            .from('merchant_profiles')
            .select('store_name')
            .eq('user_id', merchantId)
            .maybeSingle();
        const storeName = store?.store_name ?? 'Toko';

        if (order.driver_id) {
            await notificationService
                .sendToUser(order.driver_id, {
                    title: 'Pesanan sudah siap diambil 🍱',
                    body: `${storeName}: pesanan ${order.order_code} siap, silakan diambil`,
                    data: {
                        order_id: String(orderId),
                        type: 'food_ready',
                        service: 'food',
                    },
                })
                .catch((err: any) =>
                    logger.warn('[order.ready] Gagal notif driver', { orderId, err: err.message })
                );
        }

        await notificationService
            .sendToUser(order.customer_id, {
                title: 'Pesananmu sudah siap 🍱',
                body: order.driver_id
                    ? 'Driver sedang mengambil pesananmu.'
                    : 'Menunggu driver mengambil pesananmu.',
                data: {
                    order_id: String(orderId),
                    type: 'food_ready',
                    service: 'food',
                },
            })
            .catch(() => { });

        logger.info('[order.ready] Ditandai siap', { orderId, merchantId, hasDriver: !!order.driver_id });
        return updated;
    },

    // ============================================================
    // DISPATCH KE DRIVER
    // ============================================================
    async dispatchToDrivers(
        orderId: number,
        hint: { pickup?: Coords; dropoff?: Coords } = {}
    ) {
        logger.info('[order.dispatch] START', { orderId });

        const { data: order } = await supabaseAdmin
            .from('orders')
            .select('*')
            .eq('id', orderId)
            .single();

        if (!order) {
            logger.warn('[order.dispatch] Order tidak ditemukan', { orderId });
            return;
        }
        if (order.status !== 'pending') {
            logger.warn('[order.dispatch] Order tidak pending, skip', {
                orderId,
                status: order.status,
            });
            return;
        }

        const payOk =
            order.payment_status === 'paid' || order.payment_method === 'cash';
        if (!payOk) {
            logger.warn('[order.dispatch] Payment belum paid, skip', {
                orderId,
                paymentStatus: order.payment_status,
            });
            return;
        }

        if (
            order.type === 'food' &&
            order.merchant_id &&
            order.merchant_status !== 'accepted'
        ) {
            logger.warn('[order.dispatch] Toko belum menerima, skip', {
                orderId,
                merchantStatus: order.merchant_status,
            });
            return;
        }

        const { count: bidCount } = await supabaseAdmin
            .from('order_bids')
            .select('id', { count: 'exact', head: true })
            .eq('order_id', orderId);
        if ((bidCount ?? 0) > 0) {
            logger.info('[order.dispatch] Sudah pernah di-dispatch, skip', {
                orderId,
            });
            return;
        }

        const pickupCoords = hint.pickup ?? parseLocation(order.pickup_location);
        const dropoffCoords =
            hint.dropoff ?? parseLocation(order.dropoff_location);
        if (!pickupCoords) {
            logger.error('[order.dispatch] Pickup coords invalid', { orderId });
            return;
        }

        const kind = kindOf(order.type);

        const drivers = await matchingService.findDriversForOrder(
            order.id,
            pickupCoords.latitude,
            pickupCoords.longitude,
            order.type,
            order.tariff_code
        );

        logger.info('[order.dispatch] Driver ditemukan', {
            orderId,
            driverCount: drivers.length,
        });

        if (drivers.length === 0) {
            try {
                const searching = searchingForCustomer(kind);
                await notificationService.sendToUser(order.customer_id, {
                    title: searching.title,
                    body: searching.body,
                    data: {
                        order_id: order.id,
                        type: 'no_driver_yet',
                        service: order.type,
                    },
                });
            } catch (err: any) {
                logger.warn('[order.dispatch] Gagal notif customer (no driver)', {
                    orderId,
                    err: err.message,
                });
            }
            return;
        }

        let autobidDriver: string | null = null;
        try {
            const { autobidService } = await import('./autobid.service');
            autobidDriver = await autobidService.tryAutoBid(
                order.id,
                {
                    type: order.type,
                    driver_earning: Number(order.driver_earning),
                    distance_km: Number(order.distance_km),
                },
                drivers.map((d) => d.user_id)
            );
        } catch (err: any) {
            logger.warn('[order.dispatch] Autobid error', {
                orderId,
                error: err.message,
            });
        }

        const { data: custProfile } = await supabaseAdmin
            .from('profiles')
            .select('full_name, avatar_url')
            .eq('id', order.customer_id)
            .maybeSingle();

        let itemsForNotif: any[] = [];
        if (order.type === 'food') {
            const { data: orderItems } = await supabaseAdmin
                .from('order_items')
                .select('menu_item_id, name, variant, qty, price')
                .eq('order_id', order.id);
            itemsForNotif = orderItems ?? [];
        }

        const distKm = Number(order.distance_km);
        const jarakText =
            distKm < 1
                ? `${Math.round(distKm * 1000)} m`
                : `${distKm.toFixed(1)} km`;
        const pickupShort = prettyPlace(order.pickup_name);
        const dropoffShort = prettyPlace(order.dropoff_name);
        const fareText = rp(order.delivery_fee);

        const orderPayload = {
            id: String(order.id),
            order_code: order.order_code,
            type: order.type,
            status: order.status,
            pickup_name: order.pickup_name ?? '',
            pickup_address: order.pickup_address ?? '',
            pickup_coords: pickupCoords,
            dropoff_name: order.dropoff_name ?? '',
            dropoff_address: order.dropoff_address ?? '',
            dropoff_coords: dropoffCoords,
            distance_km: String(order.distance_km ?? 0),
            duration_min: String(order.duration_min ?? 0),
            delivery_fee: String(order.delivery_fee ?? 0),
            driver_earning: String(order.driver_earning ?? 0),
            total_fare: String(order.total_fare ?? 0),
            subtotal: String(order.subtotal ?? 0),
            payment_method: order.payment_method ?? 'cash',
            payment_status: order.payment_status,
            payment_reference: order.payment_reference ?? null,
            tariff_code: order.tariff_code ?? '',
            option_name: order.option_name ?? '',
            customer_name: custProfile?.full_name ?? 'Customer',
            customer_avatar: custProfile?.avatar_url ?? '',
            items: itemsForNotif,
            receiver_name: order.receiver_name ?? '',
            receiver_phone: order.receiver_phone ?? '',
            sender_name: order.sender_name ?? '',
            sender_phone: order.sender_phone ?? '',
            package_type: order.package_type ?? '',
            package_size: order.package_size ?? '',
            package_weight: order.package_weight ?? '',
            accept_expires_at: order.accept_expires_at ?? null,
        };

        const driverCopyBase = {
            kind,
            pickup: pickupShort,
            dropoff: dropoffShort,
            jarak: jarakText,
            fare: fareText,
            itemCount: itemsForNotif.length,
        };

        if (autobidDriver) {
            const driverCopy = newOrderForDriver({ ...driverCopyBase, autobid: true });

            await notificationService
                .sendToUser(autobidDriver, {
                    title: driverCopy.title,
                    body: driverCopy.body,
                    data: {
                        order_id: String(order.id),
                        type: 'autobid_accepted',
                        tariff_code: order.tariff_code ?? '',
                        service: order.type,
                        order: JSON.stringify(orderPayload),
                    },
                })
                .catch((err: any) =>
                    logger.warn('[order.dispatch] Gagal notif autobid', {
                        orderId,
                        err: err.message,
                    })
                );

            const customerCopy = driverFoundForCustomer({
                kind,
                pickup: pickupShort,
                driverName: null,
            });
            await notificationService
                .sendToUser(order.customer_id, {
                    title: customerCopy.title,
                    body: customerCopy.body,
                    data: {
                        order_id: order.id,
                        type: 'driver_accepted',
                        service: order.type,
                    },
                })
                .catch(() => { });

            await orderService.notifyMerchantDriverAssigned(order);
        } else {
            const driverCopy = newOrderForDriver({ ...driverCopyBase, autobid: false });

            const results = await Promise.allSettled(
                drivers.map((d) =>
                    notificationService.sendToUser(d.user_id, {
                        title: driverCopy.title,
                        body: driverCopy.body,
                        data: {
                            order_id: String(order.id),
                            type: 'new_order',
                            tariff_code: order.tariff_code ?? '',
                            service: order.type,
                            order: JSON.stringify(orderPayload),
                        },
                    })
                )
            );

            const failed = results.filter((r) => r.status === 'rejected').length;
            logger.info('[order.dispatch] Broadcast ke driver', {
                orderId,
                total: drivers.length,
                failed,
            });
        }

        logger.info('[order.dispatch] ✅ DONE', { orderId });
    },

    async notifyMerchantDriverAssigned(order: any, driverName?: string | null) {
        if (order.type !== 'food' || !order.merchant_id) return;
        await notificationService
            .sendToUser(order.merchant_id, {
                title: 'Driver menuju tokomu 🛵',
                body: driverName
                    ? `${driverName} akan mengambil pesanan ${order.order_code}`
                    : `Driver akan mengambil pesanan ${order.order_code}`,
                data: {
                    order_id: String(order.id),
                    type: 'driver_assigned',
                    service: 'food',
                },
            })
            .catch((err: any) =>
                logger.warn('[order] Gagal notif merchant (driver assigned)', {
                    orderId: order.id,
                    err: err.message,
                })
            );
    },

    flagRefundIfPaid(order: any) {
        if (order?.payment_status === 'paid' && order.payment_method !== 'cash') {
            logger.error('[order] PERLU REFUND — order dibatalkan setelah dibayar', {
                orderId: order.id,
                method: order.payment_method,
                amount: order.total_fare,
                customerId: order.customer_id,
            });
        }
    },

    // ============================================================
    // ACCEPT ORDER (driver)
    // ============================================================
    async accept(orderId: number, driverId: string) {
        logger.info('[order.accept] Mulai', { orderId, driverId });

        const { data: order } = await supabaseAdmin
            .from('orders')
            .select('*')
            .eq('id', orderId)
            .single();

        if (!order) throw ApiError.notFound('Order not found');
        if (order.status !== 'pending') {
            logger.warn('[order.accept] Order tidak pending', {
                orderId,
                status: order.status,
            });
            throw ApiError.conflict('Order already taken');
        }
        if (
            order.type === 'food' &&
            order.merchant_id &&
            order.merchant_status !== 'accepted'
        ) {
            throw ApiError.conflict('Pesanan belum diterima toko');
        }

        const { data: bid } = await supabaseAdmin
            .from('order_bids')
            .select('id')
            .eq('order_id', orderId)
            .eq('driver_id', driverId)
            .eq('status', 'pending')
            .maybeSingle();

        if (!bid) {
            logger.warn('[order.accept] Driver tidak diundang', {
                orderId,
                driverId,
            });
            throw ApiError.forbidden('Kamu tidak diundang untuk order ini');
        }

        const { data: dp } = await supabaseAdmin
            .from('driver_profiles')
            .select('status, is_verified')
            .eq('user_id', driverId)
            .maybeSingle();

        if (!dp) {
            throw ApiError.forbidden('Driver profile tidak ditemukan');
        }
        if (dp.status !== 'online') {
            logger.warn('[order.accept] Driver tidak online', {
                driverId,
                status: dp.status,
            });
            throw ApiError.badRequest('Kamu harus online untuk terima order');
        }
        if (!dp.is_verified) {
            logger.warn('[order.accept] Driver belum verified', { driverId });
            throw ApiError.forbidden('Akun belum terverifikasi');
        }

        const { data, error } = await supabaseAdmin
            .from('orders')
            .update({
                driver_id: driverId,
                status: 'accepted',
                accepted_at: new Date().toISOString(),
            })
            .eq('id', orderId)
            .eq('status', 'pending')
            .select()
            .single();

        if (error || !data) {
            logger.warn('[order.accept] Race condition', { orderId, driverId });
            throw ApiError.conflict('Order already taken by another driver');
        }

        logger.info('[order.accept] Order accepted', {
            orderId,
            driverId,
            type: order.type,
        });

        await supabaseAdmin
            .from('order_bids')
            .update({
                status: 'accepted',
                responded_at: new Date().toISOString(),
            })
            .eq('order_id', orderId)
            .eq('driver_id', driverId);

        await supabaseAdmin
            .from('order_bids')
            .update({
                status: 'rejected',
                responded_at: new Date().toISOString(),
            })
            .eq('order_id', orderId)
            .neq('driver_id', driverId)
            .eq('status', 'pending');

        await supabaseAdmin
            .from('driver_profiles')
            .update({ status: 'busy' })
            .eq('user_id', driverId);

        const { data: driverProfile } = await supabaseAdmin
            .from('profiles')
            .select('full_name')
            .eq('id', driverId)
            .maybeSingle();

        const { data: driverVehicle } = await supabaseAdmin
            .from('driver_profiles')
            .select('vehicle_brand, plate_number')
            .eq('user_id', driverId)
            .maybeSingle();

        const kind = kindOf(order.type);
        const pickupShort = prettyPlace(order.pickup_name);

        const copy = driverFoundForCustomer({
            kind,
            pickup: pickupShort,
            driverName: driverProfile?.full_name ?? null,
            vehicle: driverVehicle?.vehicle_brand ?? null,
            plate: driverVehicle?.plate_number ?? null,
        });

        try {
            await notificationService.sendToUser(order.customer_id, {
                title: copy.title,
                body: copy.body,
                data: {
                    order_id: orderId,
                    type: 'driver_accepted',
                    service: order.type,
                    tariff_code: order.tariff_code,
                },
            });

            logger.info('[order.accept] Notif customer terkirim', {
                orderId,
                driverId,
            });
        } catch (err: any) {
            logger.warn('[order.accept] Gagal kirim notif ke customer', {
                orderId,
                error: err.message,
            });
        }

        await orderService.notifyMerchantDriverAssigned(
            order,
            firstName(driverProfile?.full_name)
        );

        return data;
    },

    async triggerMatchingAfterPayment(orderId: number) {
        logger.info('[order.triggerMatching] START', { orderId });

        const { data: order } = await supabaseAdmin
            .from('orders')
            .select('*')
            .eq('id', orderId)
            .single();

        if (!order) {
            logger.warn('[order.triggerMatching] Order tidak ditemukan', { orderId });
            return;
        }
        if (order.status !== 'pending') {
            logger.warn('[order.triggerMatching] Order tidak pending, skip', {
                orderId,
                status: order.status,
            });
            return;
        }
        if (order.payment_status !== 'paid') {
            logger.warn('[order.triggerMatching] Payment belum paid, skip', {
                orderId,
                paymentStatus: order.payment_status,
            });
            return;
        }

        await orderService.onOrderReady(order);
        logger.info('[order.triggerMatching] ✅ DONE', { orderId });
    },

    // ============================================================
    // UPDATE STATUS
    // ============================================================
    async updateStatus(
        orderId: number,
        userId: string,
        role: string,
        status: string,
        reason?: string
    ) {
        logger.info('[order.updateStatus] Mulai', {
            orderId,
            userId,
            role,
            newStatus: status,
        });

        if (status === 'accepted' && role !== 'admin') {
            throw ApiError.badRequest(
                'Gunakan endpoint accept untuk menerima order'
            );
        }

        const { data: order } = await supabaseAdmin
            .from('orders')
            .select('*')
            .eq('id', orderId)
            .single();
        if (!order) throw ApiError.notFound();

        const isCustomer = order.customer_id === userId;
        const isDriver = order.driver_id === userId;
        const isMerchant = order.merchant_id === userId;
        if (!isCustomer && !isDriver && !isMerchant && role !== 'admin') {
            logger.warn('[order.updateStatus] Akses ditolak', { orderId, userId });
            throw ApiError.forbidden();
        }

        if (isMerchant && !isCustomer && !isDriver && role !== 'admin') {
            if (status !== 'cancelled') {
                logger.warn('[order.updateStatus] Merchant coba ubah status', {
                    orderId,
                    userId,
                    status,
                });
                throw ApiError.forbidden('Merchant hanya dapat membatalkan pesanan');
            }
            if (order.status === 'pending' && order.merchant_status === 'waiting') {
                return await orderService.merchantRespond(orderId, userId, false, {
                    reason,
                });
            }
            if (order.status !== 'pending' && order.status !== 'accepted') {
                throw ApiError.badRequest(
                    'Pesanan tidak bisa dibatalkan oleh toko pada tahap ini'
                );
            }
        }

        if (order.status === 'cancelled') {
            throw ApiError.conflict('Order sudah dibatalkan');
        }
        if (order.status === 'completed') {
            throw ApiError.conflict('Order sudah selesai');
        }

        const allowedTransitions = VALID_STATUS_TRANSITIONS[order.status] ?? [];
        if (!allowedTransitions.includes(status)) {
            logger.warn('[order.updateStatus] Transisi tidak sah', {
                orderId,
                from: order.status,
                to: status,
                allowed: allowedTransitions,
            });
            throw ApiError.badRequest(
                `Tidak bisa ubah status dari "${order.status}" ke "${status}"`
            );
        }

        if (
            status === 'cancelled' &&
            isDriver &&
            role !== 'admin' &&
            order.status === 'in_progress'
        ) {
            throw ApiError.badRequest(
                'Tidak bisa cancel saat perjalanan sudah dimulai'
            );
        }

        const patch: any = { status };
        if (status === 'arrived') patch.arrived_at = new Date().toISOString();
        if (status === 'in_progress') patch.started_at = new Date().toISOString();
        if (status === 'completed') patch.completed_at = new Date().toISOString();
        if (status === 'cancelled') {
            patch.cancelled_at = new Date().toISOString();
            patch.cancellation_reason = reason;
        }

        const { data, error } = await supabaseAdmin
            .from('orders')
            .update(patch)
            .eq('id', orderId)
            .eq('status', order.status)
            .select()
            .maybeSingle();
        if (error) throw ApiError.internal(error.message);
        if (!data) {
            logger.warn('[order.updateStatus] Status sudah berubah (race)', {
                orderId,
                expectedFrom: order.status,
                to: status,
            });
            throw ApiError.conflict(
                'Status order sudah berubah, muat ulang lalu coba lagi'
            );
        }

        logger.info('[order.updateStatus] Status updated', {
            orderId,
            from: order.status,
            to: status,
        });

        if (status === 'cancelled') {
            orderService.flagRefundIfPaid(order);
        }

        if (
            (status === 'completed' || status === 'cancelled') &&
            order.driver_id
        ) {
            await supabaseAdmin
                .from('driver_profiles')
                .update({ status: 'online' })
                .eq('user_id', order.driver_id);

            await supabaseAdmin
                .from('order_bids')
                .update({
                    status: status === 'completed' ? 'expired' : 'rejected',
                    responded_at: new Date().toISOString(),
                })
                .eq('order_id', orderId)
                .eq('status', 'pending');
        }

        if (status === 'cancelled' && !order.driver_id) {
            await supabaseAdmin
                .from('order_bids')
                .update({
                    status: 'expired',
                    responded_at: new Date().toISOString(),
                })
                .eq('order_id', orderId)
                .eq('status', 'pending');
        }

        if (status === 'completed' && order.driver_id) {
            const { count: tripsCount } = await supabaseAdmin
                .from('orders')
                .select('id', { count: 'exact', head: true })
                .eq('driver_id', order.driver_id)
                .eq('status', 'completed');

            await supabaseAdmin
                .from('driver_profiles')
                .update({ total_trips: tripsCount ?? 0 })
                .eq('user_id', order.driver_id);
        }

        if (status === 'completed' && order.driver_id) {
            try {
                const { walletService } = await import('../wallet/wallet.service');
                const settlement = await walletService.settleOrder(orderId);

                logger.info('[order.updateStatus] Wallet settled', {
                    orderId,
                    driverId: order.driver_id,
                    settlement,
                });
            } catch (err: any) {
                logger.error('[order.updateStatus] Gagal settle wallet', {
                    orderId,
                    driverId: order.driver_id,
                    error: err.message,
                });
            }
        }

        const { data: orderCustomerProfile } = await supabaseAdmin
            .from('profiles')
            .select('full_name')
            .eq('id', order.customer_id)
            .maybeSingle();

        const customerFirstName = firstName(orderCustomerProfile?.full_name);
        const dropoffShort = prettyPlace(order.dropoff_name);
        const pickupShort = prettyPlace(order.pickup_name);

        const { data: sender } = await supabaseAdmin
            .from('profiles')
            .select('full_name, role')
            .eq('id', userId)
            .maybeSingle();

        const senderIsDriver = sender?.role === 'driver';
        const senderIsCustomer = sender?.role === 'customer';
        const senderFirstName = firstName(sender?.full_name);

        const kind = kindOf(order.type);

        const notifyTargets = [
            order.customer_id,
            order.driver_id,
            order.merchant_id,
        ].filter((x) => x && x !== userId);

        for (const uid of notifyTargets) {
            try {
                const target: 'customer' | 'driver' | 'merchant' =
                    uid === order.customer_id
                        ? 'customer'
                        : uid === order.driver_id
                            ? 'driver'
                            : 'merchant';

                const copy = statusNotif({
                    kind,
                    status,
                    target,
                    senderIsDriver,
                    senderIsCustomer,
                    senderName: senderFirstName,
                    customerName: customerFirstName,
                    pickup: pickupShort,
                    dropoff: dropoffShort,
                    reason: reason ?? null,
                });

                await notificationService.sendToUser(uid as string, {
                    title: copy.title,
                    body: copy.body,
                    data: {
                        order_id: orderId,
                        type:
                            status === 'cancelled'
                                ? 'order_cancelled'
                                : 'status_update',
                        status,
                        service: order.type,
                        tariff_code: order.tariff_code,
                    },
                });

                logger.info('[order.updateStatus] Notif terkirim', {
                    orderId,
                    userId: uid,
                    target,
                    status,
                });
            } catch (err: any) {
                logger.warn('[order.updateStatus] Gagal kirim notif', {
                    uid,
                    err: err.message,
                });
            }
        }

        return data;
    },

    // ============================================================
    // GET BY ID
    // ============================================================
    async getById(orderId: number, userId: string, role: string) {
        const { data: order, error } = await supabaseAdmin
            .from('orders')
            .select('*, order_items(*), order_status_history(*)')
            .eq('id', orderId)
            .single();
        if (error || !order) throw ApiError.notFound();

        if (
            role !== 'admin' &&
            order.customer_id !== userId &&
            order.driver_id !== userId &&
            order.merchant_id !== userId
        ) {
            throw ApiError.forbidden();
        }

        const [customerRes, driverRes, merchantRes] = await Promise.all([
            supabaseAdmin
                .from('profiles')
                .select('id, full_name, phone, email, avatar_url')
                .eq('id', order.customer_id)
                .maybeSingle(),
            order.driver_id
                ? supabaseAdmin
                    .from('profiles')
                    .select('id, full_name, phone, email, avatar_url')
                    .eq('id', order.driver_id)
                    .maybeSingle()
                : Promise.resolve({ data: null }),
            order.merchant_id
                ? supabaseAdmin
                    .from('merchant_profiles')
                    .select('user_id, store_name, address, logo_url')
                    .eq('user_id', order.merchant_id)
                    .maybeSingle()
                : Promise.resolve({ data: null }),
        ]);

        let customerStats: {
            total_orders: number;
            rating_avg: number | null;
            review_count: number;
        } | null = null;

        if (order.customer_id) {
            const { data: custProfile } = await supabaseAdmin
                .from('profiles')
                .select('rating_avg, total_orders, total_reviews')
                .eq('id', order.customer_id)
                .maybeSingle();

            customerStats = {
                total_orders: custProfile?.total_orders ?? 0,
                rating_avg: custProfile?.rating_avg ?? null,
                review_count: custProfile?.total_reviews ?? 0,
            };
        }

        let driverProfile: any = null;
        let driverCoords: Coords | null = null;

        if (order.driver_id) {
            const { data: dp } = await supabaseAdmin
                .from('driver_profiles')
                .select(
                    'vehicle_type, plate_number, vehicle_brand, rating_avg, total_trips, current_location'
                )
                .eq('user_id', order.driver_id)
                .maybeSingle();

            driverProfile = dp;

            if (dp?.current_location) {
                driverCoords = parseLocation(dp.current_location);
            }
        }

        const driver = driverRes.data
            ? {
                ...driverRes.data,
                ...(driverProfile ?? {}),
                current_location: undefined,
                coords: driverCoords,
            }
            : null;

        const customer = customerRes.data
            ? {
                ...customerRes.data,
                rating_avg: customerStats?.rating_avg ?? null,
                total_orders: customerStats?.total_orders ?? 0,
                total_reviews: customerStats?.review_count ?? 0,
                stats: customerStats,
            }
            : null;

        return {
            ...order,
            pickup_coords: parseLocation(order.pickup_location),
            dropoff_coords: parseLocation(order.dropoff_location),
            customer,
            driver,
            merchant: merchantRes.data,
        };
    },

    // ============================================================
    // LIST BY USER
    // ============================================================
    async listByUser(
        userId: string,
        role: string,
        status?: string,
        limit = 50,
        offset = 0
    ) {
        const withItems = (rows: any[]) =>
            rows.map((o) => ({ ...o, items: o.order_items ?? [] }));

        const attachDrivers = async (rows: any[]) => {
            const ids = Array.from(
                new Set(rows.map((o) => o.driver_id).filter(Boolean))
            ) as string[];
            if (ids.length === 0) return rows;

            const [profRes, dpRes] = await Promise.all([
                supabaseAdmin
                    .from('profiles')
                    .select('id, full_name, phone, avatar_url')
                    .in('id', ids),
                supabaseAdmin
                    .from('driver_profiles')
                    .select('user_id, plate_number, vehicle_brand, vehicle_type')
                    .in('user_id', ids),
            ]);

            const pMap = new Map<string, any>(
                (profRes.data ?? []).map((p: any) => [p.id, p])
            );
            const dMap = new Map<string, any>(
                (dpRes.data ?? []).map((d: any) => [d.user_id, d])
            );

            return rows.map((o) =>
                o.driver_id
                    ? {
                        ...o,
                        driver: {
                            ...(pMap.get(o.driver_id) ?? {}),
                            ...(dMap.get(o.driver_id) ?? {}),
                        },
                    }
                    : o
            );
        };

        let query = supabaseAdmin
            .from('orders')
            .select(
                '*, order_items(*), customer:profiles!orders_customer_id_fkey(id, full_name, phone, avatar_url)'
            )
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (role === 'customer') query = query.eq('customer_id', userId);
        else if (role === 'driver') query = query.eq('driver_id', userId);
        else if (role === 'merchant') query = query.eq('merchant_id', userId);

        if (status) query = query.eq('status', status);

        const { data, error } = await query;
        if (error) {
            logger.warn('[order.list] Join gagal, pakai fallback', {
                error: error.message,
                userId,
                role,
            });

            let fallback = supabaseAdmin
                .from('orders')
                .select('*, order_items(*)')
                .order('created_at', { ascending: false })
                .range(offset, offset + limit - 1);

            if (role === 'customer') fallback = fallback.eq('customer_id', userId);
            else if (role === 'driver') fallback = fallback.eq('driver_id', userId);
            else if (role === 'merchant') fallback = fallback.eq('merchant_id', userId);
            if (status) fallback = fallback.eq('status', status);

            const { data: f } = await fallback;
            return attachDrivers(withItems(f || []));
        }
        return attachDrivers(withItems(data || []));
    },

    // ============================================================
    // UPLOAD PACKAGE PHOTO
    // ============================================================
    async uploadPackagePhoto(
        orderId: number,
        driverId: string,
        file: {
            originalname: string;
            mimetype: string;
            buffer: Buffer;
        }
    ) {
        logger.info('[order.uploadPhoto] Mulai', { orderId, driverId });

        const { data: orderRaw, error: oErr } = await supabaseAdmin
            .from('orders')
            .select('id, type, status, driver_id, customer_id, package_photo_url')
            .eq('id', orderId)
            .single();

        if (oErr || !orderRaw) {
            throw ApiError.notFound('Order tidak ditemukan');
        }

        const order = orderRaw as any;

        if (order.driver_id !== driverId) {
            throw ApiError.forbidden('Bukan order kamu');
        }
        if (order.type !== 'send') {
            throw ApiError.badRequest('Foto paket hanya untuk order send');
        }
        if (order.status !== 'accepted' && order.status !== 'arrived') {
            throw ApiError.badRequest(
                'Foto paket hanya bisa diupload saat order aktif'
            );
        }

        const ext = file.originalname.split('.').pop() ?? 'jpg';
        const fileName = `order-${orderId}-${Date.now()}.${ext}`;

        const { error: uploadErr } = await supabaseAdmin.storage
            .from('package-photos')
            .upload(fileName, file.buffer, {
                contentType: file.mimetype,
                upsert: true,
            });

        if (uploadErr) {
            logger.error('[order.uploadPhoto] Upload gagal', {
                error: uploadErr.message,
                orderId,
            });
            throw ApiError.internal(uploadErr.message);
        }

        const { data: urlData } = supabaseAdmin.storage
            .from('package-photos')
            .getPublicUrl(fileName);

        const photoUrl = urlData.publicUrl;

        const { error: updateErr } = await supabaseAdmin
            .from('orders')
            .update({ package_photo_url: photoUrl })
            .eq('id', orderId);

        if (updateErr) {
            logger.error('[order.uploadPhoto] Update gagal', {
                error: updateErr.message,
                orderId,
            });
            throw ApiError.internal(updateErr.message);
        }

        logger.info('[order.uploadPhoto] Sukses', { orderId, photoUrl });

        return { package_photo_url: photoUrl };
    },
};