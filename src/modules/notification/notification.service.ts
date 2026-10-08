// src/modules/notification/notification.service.ts
import { supabaseAdmin } from '../../config/supabase';
import { expoPushService } from './expoPush.service';
import { getIO } from '../../sockets';
import { logger } from '../../config/logger';

// ============================================================
// KONFIGURASI CHANNEL & SOUND PER ROLE
// ============================================================
// ⚠️ Channel ID & sound HARUS SAMA dengan:
// - _layout.tsx di masing-masing app (customer / driver / merchant)
// - app.json `defaultChannel` di masing-masing app
// - File suara di android/app/src/main/res/raw/<sound>.mp3
//   (TANPA ekstensi .mp3)
//
// Nama file suara di app:
// - customer: assets/sounds/customer.mp3
// - driver:   assets/sounds/driver-order.mp3
// - merchant: assets/sounds/merchant-order.mp3
// ============================================================

type UserRole = 'customer' | 'driver' | 'merchant';

// Nama file suara di app (ekstensi .mp3 ikut ditulis, underscore bukan tanda hubung):
// - customer: assets/sounds/customer.mp3
// - driver:   assets/sounds/driver_order.mp3
// - merchant: assets/sounds/merchant_order.mp3

const CHANNEL_MAP: Record<UserRole, string> = {
    customer: 'customer-notif-v2',      // sebelumnya v1
    driver: 'driver-orders-v4',
    merchant: 'merchant-orders-v1',
};

const SOUND_MAP: Record<UserRole, string> = {
    customer: 'customer.mp3',           // sebelumnya 'customer'
    driver: 'driver_order.mp3',
    merchant: 'merchant-order',         // lihat catatan di bawah
};

// Fallback kalau role tidak dikenal
const DEFAULT_ROLE: UserRole = 'customer';

function resolveChannel(role: string | null | undefined): {
    role: UserRole;
    channelId: string;
    sound: string;
} {
    const r = (role ?? DEFAULT_ROLE) as UserRole;
    const safeRole: UserRole = CHANNEL_MAP[r] ? r : DEFAULT_ROLE;
    return {
        role: safeRole,
        channelId: CHANNEL_MAP[safeRole],
        sound: SOUND_MAP[safeRole],
    };
}

export interface NotificationPayload {
    title: string;
    body: string;
    data?: Record<string, any>;
}

export const notificationService = {
    // ============================================================
    // KIRIM KE 1 USER
    // ============================================================
    async sendToUser(userId: string, payload: NotificationPayload) {
        // ---------- 1. Simpan ke DB ----------
        try {
            await supabaseAdmin.from('notifications').insert({
                user_id: userId,
                title: payload.title,
                body: payload.body,
                data: payload.data || {},
                channel: 'both',
                sent_at: new Date().toISOString(),
            });
        } catch (err: any) {
            logger.warn('Gagal simpan notification', {
                userId,
                err: err.message,
            });
        }

        // ---------- 2. Socket.IO ----------
        const io = getIO();
        if (io) {
            io.of('/app').to(`user:${userId}`).emit('notification:new', {
                title: payload.title,
                body: payload.body,
                data: payload.data,
                created_at: new Date().toISOString(),
            });
            logger.info('Socket emit notif', { userId });
        }

        // ---------- 3. Ambil profile (fcm_token + role) ----------
        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('fcm_token, role')
            .eq('id', userId)
            .maybeSingle();

        if (!profile?.fcm_token) {
            logger.warn('User tidak punya fcm_token, skip push', { userId });
            return true;
        }

        // ---------- 4. Tentukan channel & sound berdasarkan role ----------
        const { role, channelId, sound } = resolveChannel(profile.role);

        logger.info('Push target', {
            userId,
            role,
            channelId,
            sound,
        });

        // ---------- 5. Kirim Expo Push ----------
        const result = await expoPushService.send({
            to: profile.fcm_token,
            title: payload.title,
            body: payload.body,
            data: payload.data,
            sound,          // ← sesuai role
            priority: 'high',
            channelId,      // ← sesuai role
        });

        if (result) {
            logger.info('Push terkirim', {
                userId,
                role,
                title: payload.title,
                channelId,
                sound,
            });
        }

        return true;
    },

    // ============================================================
    // KIRIM KE BANYAK USER (group by role)
    // ============================================================
    async sendToUsers(userIds: string[], payload: NotificationPayload) {
        if (!userIds.length) return;

        // ---------- 1. Simpan ke DB batch ----------
        try {
            await supabaseAdmin.from('notifications').insert(
                userIds.map((uid) => ({
                    user_id: uid,
                    title: payload.title,
                    body: payload.body,
                    data: payload.data || {},
                    channel: 'both',
                    sent_at: new Date().toISOString(),
                }))
            );
        } catch (err: any) {
            logger.warn('Gagal batch insert notifications', {
                err: err.message,
            });
        }

        // ---------- 2. Socket.IO batch ----------
        const io = getIO();
        if (io) {
            userIds.forEach((uid) => {
                io.of('/app').to(`user:${uid}`).emit('notification:new', {
                    title: payload.title,
                    body: payload.body,
                    data: payload.data,
                });
            });
        }

        // ---------- 3. Ambil profiles dengan fcm_token ----------
        const { data: profiles } = await supabaseAdmin
            .from('profiles')
            .select('id, fcm_token, role')
            .in('id', userIds)
            .not('fcm_token', 'is', null);

        if (!profiles?.length) {
            logger.warn('Tidak ada user dengan fcm_token', { userIds });
            return;
        }

        // ---------- 4. Group by role ----------
        // Karena channel & sound beda per role, kita kirim per group
        const groups: Record<UserRole, typeof profiles> = {
            customer: [],
            driver: [],
            merchant: [],
        };

        profiles.forEach((p) => {
            const { role } = resolveChannel(p.role);
            groups[role].push(p);
        });

        // ---------- 5. Kirim per group ----------
        for (const role of Object.keys(groups) as UserRole[]) {
            const list = groups[role];
            if (!list.length) continue;

            const channelId = CHANNEL_MAP[role];
            const sound = SOUND_MAP[role];

            const messages = list.map((p) => ({
                to: p.fcm_token!,
                title: payload.title,
                body: payload.body,
                data: payload.data,
                sound,          // ← sesuai role
                priority: 'high' as const,
                channelId,      // ← sesuai role
            }));

            await expoPushService.send(messages);

            logger.info('Batch push terkirim', {
                role,
                count: messages.length,
                channelId,
                sound,
            });
        }
    },

    // ============================================================
    // LIST NOTIFIKASI
    // ============================================================
    async list(userId: string) {
        const { data } = await supabaseAdmin
            .from('notifications')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(100);
        return data || [];
    },

    // ============================================================
    // MARK AS READ
    // ============================================================
    async markRead(userId: string, notifId: number) {
        await supabaseAdmin
            .from('notifications')
            .update({ is_read: true })
            .eq('id', notifId)
            .eq('user_id', userId);
    },
};