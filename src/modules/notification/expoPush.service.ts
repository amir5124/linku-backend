import axios from 'axios';
import { logger } from '../../config/logger';
import { env } from '../../config/env';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

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

export const expoPushService = {
    /**
     * Kirim 1 atau banyak push dalam satu request.
     * Expo membatasi maksimal 100 message per request.
     */
    async send(messages: ExpoPushMessage | ExpoPushMessage[]) {
        const payload = Array.isArray(messages) ? messages : [messages];

        // Filter token yang jelas tidak valid
        const valid = payload.filter((m) => {
            if (!m.to) return false;
            if (!m.to.startsWith('ExponentPushToken[') && !m.to.startsWith('ExpoPushToken[')) {
                logger.warn('Token bukan format Expo Push', { token: m.to });
                return false;
            }
            return true;
        });

        if (valid.length === 0) return null;

        try {
            const { data } = await axios.post(EXPO_PUSH_URL, valid, {
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'Accept-Encoding': 'gzip, deflate',
                    ...(env.expoAccessToken
                        ? { Authorization: `Bearer ${env.expoAccessToken}` }
                        : {}),
                },
            });

            // data.data berisi array ticket untuk tiap message
            const tickets: ExpoPushTicket[] = Array.isArray(data?.data)
                ? data.data
                : data?.data
                    ? [data.data]
                    : [];

            // Log error ticket
            tickets.forEach((t, i) => {
                if (t.status === 'error') {
                    logger.warn('Expo push error ticket', {
                        to: valid[i]?.to,
                        message: t.message,
                        details: t.details,
                    });
                }
            });

            return data;
        } catch (err: any) {
            logger.error('Expo push request failed', {
                message: err.message,
                response: err.response?.data,
            });
            return null;
        }
    },
};