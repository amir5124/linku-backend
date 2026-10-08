import rateLimit from 'express-rate-limit';

export const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    message: { success: false, message: 'Too many requests' },
});

export const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { success: false, message: 'Too many auth attempts' },
});