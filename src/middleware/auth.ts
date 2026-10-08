import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';
import { verifyJwt } from '../utils/jwt';

/**
 * Tipe role yang tersedia dalam sistem
 */
export type UserRole = 'customer' | 'driver' | 'merchant' | 'admin';

/**
 * Payload JWT yang diharapkan dari token
 */
export interface JwtPayload {
    sub: string;      // user id
    role: UserRole;
    email: string;
    iat?: number;
    exp?: number;
}

/**
 * Middleware: requireAuth
 * Memverifikasi keberadaan dan validitas Bearer token pada header Authorization.
 * Jika valid, akan menempelkan data user ke `req.user`.
 */
export const requireAuth = (
    req: Request,
    _res: Response,
    next: NextFunction
): void => {
    try {
        const header = req.headers.authorization;

        if (!header || !header.startsWith('Bearer ')) {
            return next(ApiError.unauthorized('Missing or invalid authorization header'));
        }

        const token = header.slice(7).trim();

        if (!token) {
            return next(ApiError.unauthorized('Missing token'));
        }

        const payload = verifyJwt(token) as JwtPayload;

        if (!payload?.sub) {
            return next(ApiError.unauthorized('Invalid token payload'));
        }

        req.user = {
            id: payload.sub,
            role: payload.role,
            email: payload.email,
        };

        return next();
    } catch (err) {
        // Bisa dibedakan antara TokenExpiredError & JsonWebTokenError jika perlu
        if (err instanceof Error && err.name === 'TokenExpiredError') {
            return next(ApiError.unauthorized('Token expired'));
        }
        return next(ApiError.unauthorized('Invalid token'));
    }
};

/**
 * Middleware: requireRole
 * Membatasi akses endpoint hanya untuk role tertentu.
 * Harus digunakan SETELAH requireAuth.
 */
export const requireRole =
    (...roles: UserRole[]) =>
        (req: Request, _res: Response, next: NextFunction): void => {
            if (!req.user) {
                return next(ApiError.unauthorized('Authentication required'));
            }

            if (!roles.includes(req.user.role)) {
                return next(
                    ApiError.forbidden(
                        `Access denied. Required role: ${roles.join(' or ')}`
                    )
                );
            }

            return next();
        };

/**
 * Middleware opsional: attachUser
 * Menempelkan user ke req jika token valid, tapi tidak error jika tidak ada token.
 * Berguna untuk endpoint publik yang ingin personalisasi.
 */
export const optionalAuth = (
    req: Request,
    _res: Response,
    next: NextFunction
): void => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return next();

    try {
        const payload = verifyJwt(header.slice(7).trim()) as JwtPayload;
        if (payload?.sub) {
            req.user = {
                id: payload.sub,
                role: payload.role,
                email: payload.email,
            };
        }
    } catch {
        // abaikan error, lanjut tanpa user
    }
    return next();
};

/**
 * Middleware: requireSelfOrRole
 * Mengizinkan akses jika user adalah pemilik resource (berdasarkan param `id`)
 * atau memiliki salah satu role yang diizinkan (misalnya admin).
 */
export const requireSelfOrRole =
    (paramKey: string, ...roles: UserRole[]) =>
        (req: Request, _res: Response, next: NextFunction): void => {
            if (!req.user) return next(ApiError.unauthorized());

            const targetId = req.params[paramKey];
            const isSelf = targetId && targetId === req.user.id;
            const hasRole = roles.includes(req.user.role);

            if (!isSelf && !hasRole) {
                return next(ApiError.forbidden());
            }
            return next();
        };

export const authenticate = requireAuth;