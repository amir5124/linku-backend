// src/modules/chat/chat-window.ts
// Chat dibuka selama order berjalan, lalu ditutup CHAT_GRACE_MIN menit
// setelah order selesai (completed) atau dibatalkan (cancelled).
// Riwayat pesan tetap bisa dibaca; hanya KIRIM yang diblokir.
import { supabaseAdmin } from '../../config/supabase';
import { ApiError } from '../../utils/ApiError';

/** Lama chat masih dibuka setelah order selesai. Ubah lewat env CHAT_GRACE_MINUTES. */
export const CHAT_GRACE_MIN = Number(process.env.CHAT_GRACE_MINUTES ?? 30);

export type OrderTimes = {
    status: string;
    completed_at?: string | null;
    cancelled_at?: string | null;
    updated_at?: string | null;
};

export type ChatWindow = { chat_open: boolean; chat_closes_at: string | null };

/**
 * Jendela chat sebuah order (memakai jam server, bukan jam HP).
 *  - order masih berjalan      → chat_open: true, chat_closes_at: null
 *  - completed / cancelled     → terbuka sampai (waktu selesai + CHAT_GRACE_MIN)
 */
export function chatWindow(order: OrderTimes): ChatWindow {
    let endedAt: string | null | undefined = null;
    if (order.status === 'completed') endedAt = order.completed_at ?? order.updated_at;
    else if (order.status === 'cancelled') endedAt = order.cancelled_at ?? order.updated_at;

    if (!endedAt) return { chat_open: true, chat_closes_at: null };

    const closesAt = new Date(endedAt).getTime() + CHAT_GRACE_MIN * 60_000;
    return {
        chat_open: Date.now() < closesAt,
        chat_closes_at: new Date(closesAt).toISOString(),
    };
}

export const CHAT_CLOSED_MSG =
    'Chat sudah ditutup karena pesanan telah selesai. Hubungi bantuan jika masih ada kendala.';

/** Lempar 403 kalau chat untuk order ini sudah ditutup. */
export async function assertOrderChatOpen(orderId: number) {
    const { data: order } = await supabaseAdmin
        .from('orders')
        .select('status, completed_at, cancelled_at, updated_at')
        .eq('id', orderId)
        .maybeSingle();

    if (!order) throw ApiError.notFound('Order tidak ditemukan');
    if (!chatWindow(order).chat_open) throw ApiError.forbidden(CHAT_CLOSED_MSG);
}