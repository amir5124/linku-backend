import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';
import { logger } from '../config/logger';

export const errorHandler = (
    err: any,
    _req: Request,
    res: Response,
    _next: NextFunction
) => {
    if (err instanceof ApiError) {
        return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    logger.error('Unhandled error', { message: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'Internal server error' });
};

export const notFound = (_req: Request, res: Response) =>
    res.status(404).json({ success: false, message: 'Route not found' });