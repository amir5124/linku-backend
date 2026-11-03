// src/modules/notification/notification.service.ts
import { supabaseAdmin } from '../../config/supabase';
import { expoPushService } from './expoPush.service';
import { getIO } from '../../sockets';
import { logger } from '../../config/logger';

// ============================================================
// KONFIGURASI CHANNEL & SOUND PER ROLE
// ============================================================
// ⚠️ Channel ID & sound HARUS SAMA dengan:
// - _layout.tsx di masing-masing app (customer / driver / merchant / admin)
//   → Notifications.setNotificationChannelAsync(<channelId>, ...)
// - File suara yang didaftarkan di plugin expo-notifications (`sounds`)
//   di app.json masing-masing app
//
// Nama file suara di app (ekstensi .mp3 ikut ditulis, underscore bukan tanda hubung):
// - customer: assets/sounds/customer.mp3
// - driver:   assets/sounds/driver_order.mp3
// - merchant: assets/sounds/merchant_order.mp3
// - admin:    memakai suara bawaan ('default') sampai file suara admin dibuat
//             (kalau nanti ada: ganti ke 'admin_notif.mp3' dan daftarkan
//              di plugin expo-notifications app admin)
// ============================================================

type UserRole = 'customer' | 'driver' | 'merchant' | 'admin';

const CHANNEL_MAP: Record<UserRole, string> = {
    customer: 'customer-notif-v2',
    driver: 'driver-orders-v4',
    merchant: 'merchant-orders-v1',
    admin: 'admin-notif-v2',        // naik dari v1
};

const SOUND_MAP: Record<UserRole, string> = {
    customer: 'customer.mp3',
    driver: 'driver_order.mp3',
    merchant: 'merchant_order.mp3',
    admin: 'admin.mp3',             // sebelumnya 'default'
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

type PushMessage = {
    to: string;
    title: string;
    body: string;
    data?: Record<string, any>;
    sound: string;
    priority: 'high';
    channelId: string;
};

// ============================================================
// BERSIHKAN TOKEN YANG SUDAH TIDAK AKTIF
// Expo membalas tiap pesan dengan "tiket". Tiket berstatus error dengan
// details.error === 'DeviceNotRegistered' berarti token itu mati
// (aplikasi di-uninstall / token kedaluwarsa), jadi dihapus dari database.
//
// Hanya berjalan kalau expoPushService.send() mengembalikan daftar tiket
// (array, atau { data: [...] }) yang urutannya sama dengan pesan yang dikirim.
// Kalau bentuknya lain, pembersihan dilewati tanpa error.
// ============================================================
async function pruneDeadTokens(messages: PushMessage[], result: any) {
    try {
        const tickets: any[] | null = Array.isArray(result)
            ? result
            : Array.isArray(result?.data)
                ? result.data
                : null;

        if (!tickets || tickets.length !== messages.length) return;

        const dead: string[] = [];
        tickets.forEach((t, i) => {
            if (t?.status !== 'error') return;
            logger.warn('Push ticket error', {
                to: messages[i]?.to,
                message: t.message,
                error: t.details?.error,
            });
            if (t.details?.error === 'DeviceNotRegistered' && messages[i]?.to) {
                dead.push(messages[i].to);
            }
        });

        if (!dead.length) return;

        await supabaseAdmin.from('push_tokens').delete().in('token', dead);
        await supabaseAdmin
            .from('profiles')
            .update({ fcm_token: null })
            .in('fcm_token', dead);
        logger.info('Push token tidak aktif dihapus', { count: dead.length });
    } catch (err: any) {
        logger.warn('Gagal membersihkan push token', { err: err?.message });
    }
}

export const notificationService = {
    // ============================================================
    // KIRIM KE 1 USER (semua perangkatnya)
    // ============================================================
    async sendToUser(userId: string, payload: NotificationPayload) {
        // ---------- 1. Simpan ke DB ----------
        try {
            const { error } = await supabaseAdmin.from('notifications').insert({
                user_id: userId,
                title: payload.title,
                body: payload.body,
                data: payload.data || {},
                channel: 'both',
                sent_at: new Date().toISOString(),
            });
            if (error) {
                logger.warn('Gagal simpan notification', {
                    userId,
                    err: error.message,
                });
            }
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

        // ---------- 3. Ambil role + semua token perangkat ----------
        const [{ data: profile }, { data: tokenRows, error: tokErr }] =
            await Promise.all([
                supabaseAdmin
                    .from('profiles')
                    .select('role')
                    .eq('id', userId)
                    .maybeSingle(),
                supabaseAdmin
                    .from('push_tokens')
                    .select('token')
                    .eq('user_id', userId),
            ]);

        if (tokErr) {
            logger.warn('Gagal ambil push_tokens, skip push', {
                userId,
                err: tokErr.message,
            });
            return true;
        }

        const tokens = Array.from(
            new Set((tokenRows ?? []).map((r) => r.token as string))
        );

        if (!tokens.length) {
            logger.warn('User tidak punya push token, skip push', { userId });
            return true;
        }

        // ---------- 4. Tentukan channel & sound berdasarkan role ----------
        const { role, channelId, sound } = resolveChannel(profile?.role);

        logger.info('Push target', {
            userId,
            role,
            channelId,
            sound,
            devices: tokens.length,
        });

        // ---------- 5. Kirim Expo Push ke semua perangkat ----------
        const messages: PushMessage[] = tokens.map((to) => ({
            to,
            title: payload.title,
            body: payload.body,
            data: payload.data,
            sound,          // ← sesuai role
            priority: 'high',
            channelId,      // ← sesuai role
        }));

        const result = await expoPushService.send(messages);

        if (result) {
            logger.info('Push terkirim', {
                userId,
                role,
                title: payload.title,
                channelId,
                sound,
                devices: tokens.length,
            });
            await pruneDeadTokens(messages, result);
        }

        return true;
    },

    // ============================================================
    // KIRIM KE BANYAK USER (group by role)
    // ============================================================
    async sendToUsers(
        userIds: string[],
        payload: NotificationPayload,
        opts: { channelId?: string; sound?: string } = {}
    ) {
        if (!userIds.length) return;

        // ---------- 1. Simpan ke DB batch ----------
        try {
            const { error } = await supabaseAdmin.from('notifications').insert(
                userIds.map((uid) => ({
                    user_id: uid,
                    title: payload.title,
                    body: payload.body,
                    data: payload.data || {},
                    channel: 'both',
                    sent_at: new Date().toISOString(),
                }))
            );
            if (error) {
                logger.warn('Gagal batch insert notifications', {
                    err: error.message,
                });
            }
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

        // ---------- 3. Ambil role + token perangkat semua user ----------
        const [{ data: profiles }, { data: tokenRows, error: tokErr }] =
            await Promise.all([
                supabaseAdmin
                    .from('profiles')
                    .select('id, role')
                    .in('id', userIds),
                supabaseAdmin
                    .from('push_tokens')
                    .select('token, user_id')
                    .in('user_id', userIds),
            ]);

        if (tokErr) {
            logger.warn('Gagal ambil push_tokens, skip push', {
                err: tokErr.message,
            });
            return;
        }

        if (!tokenRows?.length) {
            logger.warn('Tidak ada user dengan push token', { userIds });
            return;
        }

        // ---------- 4. Group token by role ----------
        // Karena channel & sound beda per role, kita kirim per group
        const roleOf = new Map<string, UserRole>();
        (profiles ?? []).forEach((p) => {
            roleOf.set(p.id as string, resolveChannel(p.role).role);
        });

        const groups: Record<UserRole, string[]> = {
            customer: [],
            driver: [],
            merchant: [],
            admin: [],
        };

        const seen = new Set<string>();
        tokenRows.forEach((r) => {
            const token = r.token as string;
            if (seen.has(token)) return;
            seen.add(token);
            const role = roleOf.get(r.user_id as string) ?? DEFAULT_ROLE;
            groups[role].push(token);
        });

        // ---------- 5. Kirim per group ----------
        for (const role of Object.keys(groups) as UserRole[]) {
            const list = groups[role];
            if (!list.length) continue;

            const channelId = CHANNEL_MAP[role];
            const sound = SOUND_MAP[role];

            const messages: PushMessage[] = list.map((to) => ({
                to,
                title: payload.title,
                body: payload.body,
                data: payload.data,
                sound: opts.sound ?? sound,
                priority: 'high',
                channelId: opts.channelId ?? channelId,
            }));

            const result = await expoPushService.send(messages);

            logger.info('Batch push terkirim', {
                role,
                count: messages.length,
                channelId,
                sound,
            });

            if (result) await pruneDeadTokens(messages, result);
        }
    },

    // ============================================================
    // KIRIM KE SEMUA USER DENGAN ROLE TERTENTU
    // Contoh: notifikasi ke semua admin saat ada order bermasalah,
    //         driver baru mendaftar, atau top up menunggu verifikasi.
    // ============================================================
    async sendToRole(role: UserRole, payload: NotificationPayload) {
        const { data, error } = await supabaseAdmin
            .from('profiles')
            .select('id')
            .eq('role', role);

        if (error) {
            logger.warn('Gagal ambil user per role', { role, err: error.message });
            return;
        }

        const ids = (data ?? []).map((p) => p.id as string);
        if (!ids.length) {
            logger.warn('Tidak ada user dengan role ini', { role });
            return;
        }

        await this.sendToUsers(ids, payload);
    },

    // Pintasan untuk admin
    async sendToAdmins(payload: NotificationPayload) {
        return this.sendToRole('admin', payload);
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