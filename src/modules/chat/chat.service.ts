// src/modules/chat/chat.service.ts
import { supabaseAdmin } from '../../config/supabase';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../config/logger';
import { notificationService } from '../notification/notification.service';

export const chatService = {
    // ============================================================
    // GET / CREATE ROOM
    // ============================================================
    async getOrCreateRoom(orderId: number, userId: string) {
        const { data: order } = await supabaseAdmin
            .from('orders')
            .select('id, customer_id, driver_id, merchant_id')
            .eq('id', orderId)
            .single();

        if (!order) throw ApiError.notFound('Order tidak ditemukan');

        const isParticipant =
            order.customer_id === userId ||
            order.driver_id === userId ||
            order.merchant_id === userId;

        if (!isParticipant) throw ApiError.forbidden('Bukan peserta order ini');
        if (!order.driver_id) throw ApiError.badRequest('Order belum punya driver');

        const { data: existing } = await supabaseAdmin
            .from('chat_rooms')
            .select('*')
            .eq('order_id', orderId)
            .maybeSingle();

        if (existing) return existing;

        const { data, error } = await supabaseAdmin
            .from('chat_rooms')
            .insert({
                order_id: orderId,
                customer_id: order.customer_id,
                driver_id: order.driver_id,
                merchant_id: order.merchant_id,
            })
            .select()
            .single();

        if (error) throw ApiError.internal(error.message);
        return data;
    },

    // ============================================================
    // 🆕 LIST ROOMS — daftar chat untuk halaman "Pesan"
    // ============================================================
    async listRooms(userId: string, limit = 50) {
        // 1. Cari semua room yang melibatkan user ini
        const { data: rooms, error: roomErr } = await supabaseAdmin
            .from('chat_rooms')
            .select(
                'id, order_id, customer_id, driver_id, merchant_id, last_message_at, created_at'
            )
            .or(
                `customer_id.eq.${userId},driver_id.eq.${userId},merchant_id.eq.${userId}`
            )
            .order('last_message_at', {
                ascending: false,
                nullsFirst: false,
            })
            .limit(limit);

        if (roomErr) {
            logger.error('Gagal list chat rooms', {
                error: roomErr,
                userId,
            });
            throw ApiError.internal(roomErr.message);
        }

        if (!rooms || rooms.length === 0) return [];

        const roomIds = rooms.map((r) => r.id);

        // 2. Ambil pesan terakhir untuk setiap room
        const { data: lastMessages } = await supabaseAdmin
            .from('chat_messages')
            .select('room_id, message, message_type, sender_id, created_at')
            .in('room_id', roomIds)
            .order('created_at', { ascending: false });

        // Map: room_id → last message
        const lastMsgMap = new Map<number, any>();
        for (const m of lastMessages ?? []) {
            if (!lastMsgMap.has(m.room_id)) {
                lastMsgMap.set(m.room_id, m);
            }
        }

        // 3. Hitung unread per room
        const unreadMap = new Map<number, number>();
        const { data: unreadData } = await supabaseAdmin
            .from('chat_messages')
            .select('room_id')
            .in('room_id', roomIds)
            .eq('is_read', false)
            .neq('sender_id', userId);

        for (const m of unreadData ?? []) {
            unreadMap.set(m.room_id, (unreadMap.get(m.room_id) ?? 0) + 1);
        }

        // 4. Ambil profil lawan bicara
        const peerIds = new Set<string>();
        for (const r of rooms) {
            if (r.customer_id !== userId) peerIds.add(r.customer_id);
            if (r.driver_id && r.driver_id !== userId) peerIds.add(r.driver_id);
            if (r.merchant_id && r.merchant_id !== userId)
                peerIds.add(r.merchant_id);
        }

        const peerIdsArr = Array.from(peerIds);

        let profiles: any[] = [];
        if (peerIdsArr.length > 0) {
            const { data } = await supabaseAdmin
                .from('profiles')
                .select('id, full_name, avatar_url, role')
                .in('id', peerIdsArr);
            profiles = data ?? [];
        }

        const profileMap = new Map(profiles.map((p) => [p.id, p]));

        // 5. Gabungkan
        return rooms.map((r) => {
            // Tentukan peer (siapa yang bukan userId)
            let peerId = '';
            if (r.customer_id !== userId) peerId = r.customer_id;
            else if (r.driver_id && r.driver_id !== userId)
                peerId = r.driver_id;
            else if (r.merchant_id && r.merchant_id !== userId)
                peerId = r.merchant_id;

            const peer = profileMap.get(peerId);
            const lastMsg = lastMsgMap.get(r.id);

            return {
                id: r.id,
                order_id: r.order_id,
                peer_id: peerId,
                peer_name: peer?.full_name ?? 'Chat',
                peer_avatar: peer?.avatar_url ?? null,
                peer_role: peer?.role ?? 'user',
                last_message: lastMsg?.message ?? '',
                last_message_type: lastMsg?.message_type ?? 'text',
                last_message_at:
                    r.last_message_at ?? lastMsg?.created_at ?? null,
                created_at: r.created_at,
                unread_count: unreadMap.get(r.id) ?? 0,
            };
        });
    },

    // ============================================================
    // LIST MESSAGES
    // ============================================================
    async listMessages(roomId: number, userId: string, limit = 100) {
        const { data: room } = await supabaseAdmin
            .from('chat_rooms')
            .select('customer_id, driver_id, merchant_id')
            .eq('id', roomId)
            .single();

        if (!room) throw ApiError.notFound('Room tidak ditemukan');

        const isParticipant =
            room.customer_id === userId ||
            room.driver_id === userId ||
            room.merchant_id === userId;

        if (!isParticipant) throw ApiError.forbidden();

        const { data, error } = await supabaseAdmin
            .from('chat_messages')
            .select('*')
            .eq('room_id', roomId)
            .order('created_at', { ascending: true })
            .limit(limit);

        if (error) throw ApiError.internal(error.message);
        return data || [];
    },

    // ============================================================
    // SEND MESSAGE
    // ============================================================
    async sendMessage(
        roomId: number,
        senderId: string,
        message: string,
        type = 'text'
    ) {
        const { data: room } = await supabaseAdmin
            .from('chat_rooms')
            .select('id, order_id, customer_id, driver_id, merchant_id')
            .eq('id', roomId)
            .single();

        if (!room) throw ApiError.notFound();

        const isParticipant =
            room.customer_id === senderId ||
            room.driver_id === senderId ||
            room.merchant_id === senderId;

        if (!isParticipant) throw ApiError.forbidden();

        const { data, error } = await supabaseAdmin
            .from('chat_messages')
            .insert({
                room_id: roomId,
                sender_id: senderId,
                message,
                message_type: type,
            })
            .select()
            .single();

        if (error) throw ApiError.internal(error.message);

        await supabaseAdmin
            .from('chat_rooms')
            .update({ last_message_at: new Date().toISOString() })
            .eq('id', roomId);

        // Broadcast realtime (async)
        this.broadcastMessage(roomId, room.order_id, data).catch((err) => {
            logger.warn('Gagal broadcast chat', { err: err.message });
        });

        // Kirim notifikasi (async)
        this.notifyRecipient(room, senderId, message, type).catch((err) => {
            logger.warn('Gagal kirim notif chat', { err: err.message });
        });

        return data;
    },

    // ============================================================
    // MARK READ
    // ============================================================
    async markRead(roomId: number, userId: string) {
        await supabaseAdmin
            .from('chat_messages')
            .update({ is_read: true })
            .eq('room_id', roomId)
            .neq('sender_id', userId);
    },

    // ============================================================
    // UPLOAD IMAGE
    // ============================================================
    async uploadImage(
        roomId: number,
        senderId: string,
        file: { buffer: Buffer; mimetype: string; originalname: string }
    ) {
        const { data: room } = await supabaseAdmin
            .from('chat_rooms')
            .select('id, order_id, customer_id, driver_id, merchant_id')
            .eq('id', roomId)
            .single();

        if (!room) throw ApiError.notFound('Room tidak ditemukan');

        const isParticipant =
            room.customer_id === senderId ||
            room.driver_id === senderId ||
            room.merchant_id === senderId;

        if (!isParticipant) throw ApiError.forbidden('Bukan peserta chat');

        const ext = file.originalname.split('.').pop() || 'jpg';
        const filename = `${roomId}/${senderId}-${Date.now()}.${ext}`;

        const { error: upErr } = await supabaseAdmin.storage
            .from('chat-images')
            .upload(filename, file.buffer, {
                contentType: file.mimetype,
                upsert: false,
            });

        if (upErr) {
            logger.error('Gagal upload chat image', { error: upErr, roomId });
            throw ApiError.internal(upErr.message);
        }

        const { data: urlData } = supabaseAdmin.storage
            .from('chat-images')
            .getPublicUrl(filename);

        const publicUrl = urlData.publicUrl;

        const { data: message, error: msgErr } = await supabaseAdmin
            .from('chat_messages')
            .insert({
                room_id: roomId,
                sender_id: senderId,
                message: null,
                attachment_url: publicUrl,
                message_type: 'image',
            })
            .select()
            .single();

        if (msgErr) {
            logger.error('Gagal insert chat image message', {
                error: msgErr,
            });
            throw ApiError.internal(msgErr.message);
        }

        await supabaseAdmin
            .from('chat_rooms')
            .update({ last_message_at: new Date().toISOString() })
            .eq('id', roomId);

        // Broadcast realtime
        this.broadcastMessage(roomId, room.order_id, message).catch((err) => {
            logger.warn('Gagal broadcast chat image', { err: err.message });
        });

        // Notif
        this.notifyRecipient(room, senderId, null, 'image').catch((err) => {
            logger.warn('Gagal kirim notif chat image', { err: err.message });
        });

        return message;
    },

    // ============================================================
    // UNREAD COUNT BY ORDER
    // ============================================================
    async unreadCountByOrder(orderId: number, userId: string) {
        const { data: room } = await supabaseAdmin
            .from('chat_rooms')
            .select('id, customer_id, driver_id, merchant_id')
            .eq('order_id', orderId)
            .maybeSingle();

        if (!room) return { room_id: null, unread: 0 };

        const isParticipant =
            room.customer_id === userId ||
            room.driver_id === userId ||
            room.merchant_id === userId;
        if (!isParticipant) throw ApiError.forbidden();

        const { count, error } = await supabaseAdmin
            .from('chat_messages')
            .select('id', { count: 'exact', head: true })
            .eq('room_id', room.id)
            .eq('is_read', false)
            .neq('sender_id', userId);

        if (error) throw ApiError.internal(error.message);
        return { room_id: room.id, unread: count ?? 0 };
    },

    // ============================================================
    // BROADCAST
    // ============================================================
    async broadcastMessage(roomId: number, orderId: number, message: unknown) {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!url || !key) {
            logger.warn(
                'Broadcast dilewati: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum diset'
            );
            return;
        }

        const res = await fetch(`${url}/realtime/v1/api/broadcast`, {
            method: 'POST',
            headers: {
                apikey: key,
                Authorization: `Bearer ${key}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messages: [
                    {
                        topic: `chat:${roomId}`,
                        event: 'new_message',
                        payload: message,
                        private: false,
                    },
                    {
                        topic: `order-chat:${orderId}`,
                        event: 'new_message',
                        payload: { room_id: roomId },
                        private: false,
                    },
                ],
            }),
        });

        if (!res.ok) {
            throw new Error(
                `Broadcast gagal: ${res.status} ${await res.text()}`
            );
        }
    },

    // ============================================================
    // NOTIFY RECIPIENT
    // ============================================================
    async notifyRecipient(
        room: {
            id: number;
            order_id: number;
            customer_id: string;
            driver_id: string | null;
            merchant_id: string | null;
        },
        senderId: string,
        message: string | null,
        type: string
    ) {
        let recipientId: string | null = null;
        if (room.customer_id === senderId) {
            recipientId = room.driver_id;
        } else if (room.driver_id === senderId) {
            recipientId = room.customer_id;
        } else if (room.merchant_id === senderId) {
            recipientId = room.customer_id;
        }

        if (!recipientId) return;

        const { data: sender } = await supabaseAdmin
            .from('profiles')
            .select('full_name, role')
            .eq('id', senderId)
            .maybeSingle();

        const senderName = sender?.full_name ?? 'Pengguna';

        let preview = '';
        if (type === 'image') {
            preview = '📷 Mengirim foto';
        } else if (message) {
            preview =
                message.length > 60 ? message.slice(0, 60) + '…' : message;
        } else {
            preview = 'Pesan baru';
        }

        await notificationService.sendToUser(recipientId, {
            title: `Pesan dari ${senderName}`,
            body: preview,
            data: {
                type: 'chat_message',
                room_id: room.id ?? undefined,
                order_id: room.order_id,
            },
        });
    },
};