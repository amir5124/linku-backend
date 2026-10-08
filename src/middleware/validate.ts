// src/middleware/validate.ts
import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';
import { ApiError } from '../utils/ApiError';

export const validate =
    (schema: ZodSchema) =>
        (req: Request, _res: Response, next: NextFunction) => {
            const result = schema.safeParse({
                body: req.body,
                query: req.query,
                params: req.params,
            });

            if (!result.success) {
                return next(
                    ApiError.badRequest(
                        result.error.errors.map((e) => e.message).join(', ')
                    )
                );
            }

            // ═══════════════════════════════════════════════════════════
            // ✅ FIX: Replace req.body, query, params secara eksplisit
            // ═══════════════════════════════════════════════════════════
            if (result.data.body !== undefined) {
                req.body = result.data.body;
            }
            if (result.data.query !== undefined) {
                req.query = result.data.query as any;
            }
            if (result.data.params !== undefined) {
                req.params = result.data.params as any;
            }

            next();
        };