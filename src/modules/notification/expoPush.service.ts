import axios from 'axios';
import { logger } from '../../config/logger';
import { env } from '../../config/env';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

// Expo membatasi maksimal 100 message per request
const CHUNK_SIZE = 100;
// Jangan biarkan request ke Expo menggantung (pengiriman push di-await di alur order)
const REQUEST_TIMEOUT_MS = 15_000;

export interface ExpoPushMessage {
    to: string;
    title: string;
    body: string;
    data?: Record<string, any>;
    sound?: 'default' | null | (string & {});  // ← terima custom sound
    priority?: 'default' | 'normal' | 'high';
    channelId?: string;
    badge?: number;
}

export interface ExpoPushTicket {
    status: 'ok' | 'error';
    id?: string;
    message?: string;
    details?: Record<string, any>;
}

const isExpoToken = (to?: string) =>
    !!to && (to.startsWith('ExponentPushToken[') || to.startsWith('ExpoPushToken['));

export const expoPushService = {
    /**
     * Kirim 1 atau banyak push. Pesan dipecah per 100 per request.
     *
     * Hasil: `{ data: tickets }` (bentuk sama dengan respons Expo), dengan
     * `tickets` SELALU sejajar 1:1 dengan urutan pesan yang dikirim: pesan ke-i
     * punya tiket ke-i. Pesan yang tidak dikirim (token tidak valid, request
     * gagal) mendapat tiket berstatus 'error' sehingga urutan tidak bergeser.
     * Mengembalikan null kalau tidak ada satu pun pesan yang sampai ke Expo.
     */
    async send(
        messages: ExpoPushMessage | ExpoPushMessage[]
    ): Promise<{ data: ExpoPushTicket[] } | null> {
        const payload = Array.isArray(messages) ? messages : [messages];
        if (payload.length === 0) return null;

        // Tiket awal: semua dianggap belum terkirim
        const tickets: ExpoPushTicket[] = payload.map(() => ({
            status: 'error',
            message: 'Tidak ada tiket dari Expo',
            details: { error: 'NoTicket' },
        }));

        // Index pesan yang formatnya valid
        const sendable: number[] = [];
        payload.forEach((m, i) => {
            if (isExpoToken(m.to)) {
                sendable.push(i);
            } else {
                logger.warn('Token bukan format Expo Push', { token: m.to });
                tickets[i] = {
                    status: 'error',
                    message: 'Format token bukan Expo Push',
                    details: { error: 'InvalidToken' },
                };
            }
        });

        if (sendable.length === 0) return null;

        const headers = {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'Accept-Encoding': 'gzip, deflate',
            ...(env.expoAccessToken
                ? { Authorization: `Bearer ${env.expoAccessToken}` }
                : {}),
        };

        let anySent = false;

        for (let start = 0; start < sendable.length; start += CHUNK_SIZE) {
            const idxs = sendable.slice(start, start + CHUNK_SIZE);
            const chunk = idxs.map((i) => payload[i]);

            try {
                const { data } = await axios.post(EXPO_PUSH_URL, chunk, {
                    headers,
                    timeout: REQUEST_TIMEOUT_MS,
                });

                // data.data berisi array ticket untuk tiap message
                const res: ExpoPushTicket[] = Array.isArray(data?.data)
                    ? data.data
                    : data?.data
                        ? [data.data]
                        : [];

                idxs.forEach((payloadIdx, k) => {
                    const t = res[k];
                    if (!t) return; // tetap memakai tiket awal (NoTicket)
                    tickets[payloadIdx] = t;

                    if (t.status === 'error') {
                        logger.warn('Expo push error ticket', {
                            to: payload[payloadIdx]?.to,
                            message: t.message,
                            details: t.details,
                        });
                    }
                });

                anySent = true;
            } catch (err: any) {
                logger.error('Expo push request failed', {
                    message: err.message,
                    response: err.response?.data,
                });
                idxs.forEach((payloadIdx) => {
                    tickets[payloadIdx] = {
                        status: 'error',
                        message: err.message,
                        details: { error: 'RequestFailed' },
                    };
                });
            }
        }

        return anySent ? { data: tickets } : null;
    },
};