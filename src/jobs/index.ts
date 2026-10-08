import { startReminderJob } from './reminder.job';
import { logger } from '../config/logger';

export const startJobs = () => {
    startReminderJob();
    logger.info('Cron jobs started');
};