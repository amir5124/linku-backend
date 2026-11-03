// src/modules/broadcast/broadcast.service.ts
// Broadcast notifikasi custom dari admin ke customer / driver / merchant.
//
// Cara kerja:
//  1. create() menyimpan baris di tabel `broadcasts` (status 'sending'),
//     lalu menjalankan pengiriman di latar belakang.
//  2. Pengiriman membaca user per role secara bertahap (PAGE), lalu memanggil
//     notificationService.sendToUsers per paket 100 user (batas Expo Push).
//     sendToUsers menyimpan notifikasi di tabel `notifications` (kotak masuk
//     dalam app), emit Socket.IO, dan mengirim push ke yang punya token.
//  3. Progres bisa dipantau lewat GET /:id (processed_count / total_targets).
//
// Catatan: pengiriman berjalan di dalam proses server. Kalau server restart di
// tengah jalan, baris tertinggal berstatus 'sending'; panggil
// broadcastService.failStuck() saat server start untuk menandainya gagal.
import { supabaseAdmin } from '../../config/supabase';
import { logger } from '../../config/logger';
import { ApiError } from '../../utils/ApiError';
import { notificationService } from '../notification/notification.service';

export type Audience = 'customer' | 'driver' | 'merchant';

const ALL_ROLES: Audience[] = ['customer', 'driver', 'merchant'];

/** Jumlah user dibaca per halaman dari tabel profiles */
const PAGE = 500;
/** Jumlah user per panggilan sendToUsers (Expo membatasi 100 pesan per request) */
const CHUNK = 100;
/** Jeda antar paket supaya tidak membebani Expo / database */
const PAUSE_MS = 150;
/** Broadcast identik dari admin yang sama dalam rentang ini dianggap klik ganda */
const DUPLICATE_WINDOW_MS = 60_000;

/**
 * Channel Android untuk broadcast. Harus dibuat di KETIGA app
 * (customer, driver, merchant) dengan ID yang sama.
 * Kalau channel belum ada di sebuah app, Android memakai channel bawaan.
 */
export const BROADCAST_CHANNEL = 'broadcast-v1';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function uniqueAudience(input: string[]): Audience[] {
    return ALL_ROLES.filter((r) => input.includes(r));
}

function buildData(broadcastId: number | string, screen?: string) {
    return {
        type: 'broadcast',
        broadcast_id: String(broadcastId),
        ...(screen ? { screen } : {}),
    };
}

// ============================================================
// Pengiriman (latar belakang)
// ============================================================
async function runBroadcast(
    id: number,
    audience: Audience[],
    payload: { title: string; body: string; data: Record<string, any> }
) {
    let processed = 0;
    let failedChunks = 0;

    try {
        for (const role of audience) {
            let from = 0;

            for (; ;) {
                const { data, error } = await supabaseAdmin
                    .from('profiles')
                    .select('id')
                    .eq('role', role)
                    .order('id', { ascending: true })
                    .range(from, from + PAGE - 1);

                if (error) throw new Error(`Gagal membaca user ${role}: ${error.message}`);
                if (!data || data.length === 0) break;

                const ids = data.map((r: any) => r.id as string);

                for (let i = 0; i < ids.length; i += CHUNK) {
                    const chunk = ids.slice(i, i + CHUNK);
                    try {
                        await notificationService.sendToUsers(chunk, payload, {
                            channelId: BROADCAST_CHANNEL,
                            sound: 'default',
                        });
                        processed += chunk.length;
                    } catch (err: any) {
                        failedChunks += 1;
                        logger.warn('[broadcast] Paket gagal', {
                            broadcastId: id,
                            role,
                            size: chunk.length,
                            err: err?.message,
                        });
                    }
                    await sleep(PAUSE_MS);
                }

                await supabaseAdmin
                    .from('broadcasts')
                    .update({ processed_count: processed, failed_chunks: failedChunks })
                    .eq('id', id);

                if (data.length < PAGE) break;
                from += PAGE;
            }
        }

        await supabaseAdmin
            .from('broadcasts')
            .update({
                status: 'sent',
                processed_count: processed,
                failed_chunks: failedChunks,
                finished_at: new Date().toISOString(),
            })
            .eq('id', id);

        logger.info('[broadcast] Selesai', { broadcastId: id, processed, failedChunks });
    } catch (err: any) {
        logger.error('[broadcast] Gagal', { broadcastId: id, err: err?.message });
        await supabaseAdmin
            .from('broadcasts')
            .update({
                status: 'failed',
                processed_count: processed,
                failed_chunks: failedChunks,
                error: String(err?.message ?? 'Gagal').slice(0, 300),
                finished_at: new Date().toISOString(),
            })
            .eq('id', id);
    }
}

// ============================================================
// API service
// ============================================================
export const broadcastService = {
    /** Jumlah penerima per role (total user, dan yang punya token push) */
    async preview(audienceInput: string[]) {
        const audience = uniqueAudience(audienceInput);
        if (!audience.length) throw ApiError.badRequest('Pilih minimal satu penerima');

        const rows = await Promise.all(
            audience.map(async (role) => {
                const [all, push] = await Promise.all([
                    supabaseAdmin
                        .from('profiles')
                        .select('id', { count: 'exact', head: true })
                        .eq('role', role),
                    supabaseAdmin
                        .from('profiles')
                        .select('id', { count: 'exact', head: true })
                        .eq('role', role)
                        .not('fcm_token', 'is', null),
                ]);
                return {
                    role,
                    total: all.count ?? 0,
                    with_push: push.count ?? 0,
                };
            })
        );

        return {
            audience: rows,
            total_users: rows.reduce((s, r) => s + r.total, 0),
            total_with_push: rows.reduce((s, r) => s + r.with_push, 0),
        };
    },

    /** Kirim contoh ke admin yang sedang login (untuk cek tampilan sebelum broadcast) */
    async test(
        adminId: string,
        input: { title: string; body: string; screen?: string }
    ) {
        await notificationService.sendToUsers(
            [adminId],
            {
                title: `[TES] ${input.title}`.slice(0, 80),
                body: input.body,
                data: buildData('test', input.screen),
            },
            { channelId: BROADCAST_CHANNEL, sound: 'default' }
        );
        return { sent_to: adminId };
    },

    /** Buat broadcast dan mulai kirim di latar belakang */
    async create(
        adminId: string,
        input: { title: string; body: string; audience: string[]; screen?: string }
    ) {
        const audience = uniqueAudience(input.audience);
        if (!audience.length) throw ApiError.badRequest('Pilih minimal satu penerima');

        // Cegah klik ganda: broadcast sama persis dari admin yang sama dalam 1 menit terakhir
        const since = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
        const { data: dup } = await supabaseAdmin
            .from('broadcasts')
            .select('id')
            .eq('created_by', adminId)
            .eq('title', input.title)
            .eq('body', input.body)
            .gte('created_at', since)
            .limit(1)
            .maybeSingle();
        if (dup) {
            throw ApiError.conflict(
                'Broadcast yang sama baru saja dikirim. Tunggu sebentar sebelum mengirim ulang.'
            );
        }

        const counts = await broadcastService.preview(audience);
        if (counts.total_users === 0) {
            throw ApiError.badRequest('Tidak ada penerima pada audience yang dipilih');
        }

        const { data: row, error } = await supabaseAdmin
            .from('broadcasts')
            .insert({
                title: input.title,
                body: input.body,
                audience,
                data: input.screen ? { screen: input.screen } : {},
                status: 'sending',
                total_targets: counts.total_users,
                created_by: adminId,
                started_at: new Date().toISOString(),
            })
            .select()
            .single();

        if (error || !row) {
            logger.error('[broadcast] Gagal simpan', { err: error?.message });
            throw ApiError.internal(error?.message ?? 'Gagal membuat broadcast');
        }

        logger.info('[broadcast] Mulai', {
            broadcastId: row.id,
            adminId,
            audience,
            totalTargets: counts.total_users,
        });

        // Jalankan di latar belakang, jangan menahan respons HTTP
        void runBroadcast(row.id, audience, {
            title: input.title,
            body: input.body,
            data: buildData(row.id, input.screen),
        });

        return row;
    },

    async list(limit = 50) {
        const { data, error } = await supabaseAdmin
            .from('broadcasts')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(limit);
        if (error) throw ApiError.internal(error.message);

        const rows = data ?? [];
        const adminIds = Array.from(new Set(rows.map((r: any) => r.created_by)));
        const names = new Map<string, string>();
        if (adminIds.length) {
            const { data: profiles } = await supabaseAdmin
                .from('profiles')
                .select('id, full_name')
                .in('id', adminIds);
            (profiles ?? []).forEach((p: any) => names.set(p.id, p.full_name));
        }

        return rows.map((r: any) => ({
            ...r,
            created_by_name: names.get(r.created_by) ?? null,
        }));
    },

    async detail(id: number) {
        const { data, error } = await supabaseAdmin
            .from('broadcasts')
            .select('*')
            .eq('id', id)
            .maybeSingle();
        if (error) throw ApiError.internal(error.message);
        if (!data) throw ApiError.notFound('Broadcast tidak ditemukan');
        return data;
    },

    /**
     * Tandai broadcast yang tertinggal berstatus 'sending' sebagai gagal.
     * Panggil sekali saat server start: pengiriman berjalan di dalam proses,
     * jadi baris 'sending' yang ada saat boot pasti sudah mati.
     */
    async failStuck() {
        const { data } = await supabaseAdmin
            .from('broadcasts')
            .update({
                status: 'failed',
                error: 'Server restart sebelum pengiriman selesai',
                finished_at: new Date().toISOString(),
            })
            .eq('status', 'sending')
            .select('id');
        if (data?.length) {
            logger.warn('[broadcast] Menandai gagal (tertinggal saat restart)', {
                ids: data.map((r: any) => r.id),
            });
        }
    },
};