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

    forgotPassword: asyncHandler(async (req: Request, res: Response) => {
        await authService.forgotPassword(req.body.email);
        // Respons sama apa pun hasilnya (anti enumerasi email)
        return ok(res, null, 'Jika email terdaftar, kode reset telah dikirim');
    }),

    resetPassword: asyncHandler(async (req: Request, res: Response) => {
        await authService.resetPassword(req.body);
        return ok(res, null, 'Password berhasil diganti, silakan login');
    }),

    changePassword: asyncHandler(async (req: Request, res: Response) => {
        const { current_password, new_password } = req.body;
        await authService.changePassword(req.user!.id, current_password, new_password);
        return ok(res, null, 'Password berhasil diganti');
    }),
};