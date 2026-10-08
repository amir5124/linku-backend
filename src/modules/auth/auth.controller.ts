import { Request, Response } from 'express';
import { authService } from './auth.service';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok, created } from '../../utils/response';

export const authController = {
    register: asyncHandler(async (req: Request, res: Response) => {
        const result = await authService.register(req.body);
        return created(res, result, 'Registered');
    }),

    login: asyncHandler(async (req: Request, res: Response) => {
        const { email, password } = req.body;
        const result = await authService.login(email, password);
        return ok(res, result, 'Logged in');
    }),

    me: asyncHandler(async (req: Request, res: Response) => {
        const result = await authService.me(req.user!.id);
        return ok(res, result);
    }),
};