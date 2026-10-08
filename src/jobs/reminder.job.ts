import cron from 'node-cron';
import { supabaseAdmin } from '../config/supabase';
import { notificationService } from '../modules/notification/notification.service';
import { logger } from '../config/logger';

// Setiap 5 menit: cari user yang buka menu 5-30 menit lalu, belum order
export const startReminderJob = () => {
    cron.schedule('*/5 * * * *', async () => {
        try {
            const { data: candidates } = await supabaseAdmin
                .from('menu_views')
                .select('id, user_id')
                .eq('has_ordered', false)
                .is('reminded_at', null)
                .lt('viewed_at', new Date(Date.now() - 5 * 60 * 1000).toISOString())
                .gt('viewed_at', new Date(Date.now() - 30 * 60 * 1000).toISOString());

            if (!candidates?.length) return;

            for (const c of candidates) {
                await notificationService.sendToUser(c.user_id, {
                    title: 'Masih lihat-lihat? 🚗',
                    body: 'Driver di sekitar sudah siap, order sekarang lebih cepat',
                    data: { type: 'menu_reminder' },
                });
                await supabaseAdmin
                    .from('menu_views')
                    .update({ reminded_at: new Date().toISOString() })
                    .eq('id', c.id);
            }
            logger.info(`Reminder sent to ${candidates.length} users`);
        } catch (err: any) {
            logger.error('Reminder job failed', { err: err.message });
        }
    });
};