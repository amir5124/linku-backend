import { NextFunction, Request, Response } from 'express';
import { activityService, QuoteBody } from './activity.service';

const SERVICES = ['ride', 'send', 'food'];

const userIdOf = (req: Request): string => (req as any).user.id; // ← sesuaikan bila bentuk req.user beda

export const activityController = {
    async ping(req: Request, res: Response, next: NextFunction) {
        try {
            await activityService.ping(userIdOf(req));
            res.json({ success: true, data: null });
        } catch (err) {
            next(err);
        }
    },

    async quote(req: Request, res: Response, next: NextFunction) {
        try {
            const body = (req.body ?? {}) as QuoteBody;
            if (!SERVICES.includes(body.service)) {
                return res
                    .status(400)
                    .json({ success: false, message: 'service tidak valid' });
            }
            await activityService.trackQuote(userIdOf(req), body);
            res.json({ success: true, data: null });
        } catch (err) {
            next(err);
        }
    },
};