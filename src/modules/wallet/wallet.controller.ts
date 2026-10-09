// src/modules/wallet/wallet.controller.ts
import { Request, Response } from 'express';
import { walletService } from './wallet.service';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok, created } from '../../utils/response';
import { ApiError } from '../../utils/ApiError';

// ============================================================
// Helper: role user untuk wallet
// ============================================================
function resolveWalletRole(req: Request): 'driver' | 'customer' {
    return req.user?.role === 'driver' ? 'driver' : 'customer';
}

export const walletController = {
    // ============================================================
    // GET /api/wallet
    // ============================================================
    getWallet: asyncHandler(async (req: Request, res: Response) => {
        const data = req.user?.role === 'driver'
            ? await walletService.getWallet(req.user!.id, 'driver')
            : await walletService.getWallet(req.user!.id, 'customer');
        return ok(res, data);
    }),
    // ============================================================
    // GET /api/wallet/ledger
    // ============================================================
    listLedger: asyncHandler(async (req: Request, res: Response) => {
        const limit = Number(req.query.limit ?? 50);
        const offset = Number(req.query.offset ?? 0);
        const role = resolveWalletRole(req);

        const data = role === 'driver'
            ? await walletService.listLedger(req.user!.id, limit, offset)
            : await walletService.listLedgerCustomer(req.user!.id, limit, offset);

        return ok(res, data);
    }),

    // ============================================================
    // GET /api/wallet/payouts (driver only)
    // ============================================================
    listPayouts: asyncHandler(async (req: Request, res: Response) => {
        const data = await walletService.listPayouts(req.user!.id);
        return ok(res, data);
    }),

    // ============================================================
    // POST /api/wallet/payouts (driver only)
    // ============================================================
    requestPayout: asyncHandler(async (req: Request, res: Response) => {
        const { amount, bank_code, bank_name, account_number, account_name } = req.body;

        if (!amount || amount <= 0) throw ApiError.badRequest('Jumlah tidak valid');
        if (!bank_code || !account_number || !account_name)
            throw ApiError.badRequest('Info bank tidak lengkap');

        const data = await walletService.requestPayout(
            req.user!.id,
            Number(amount),
            { bank_code, bank_name, account_number, account_name }
        );
        return created(res, data, 'Pencairan sedang diproses');
    }),

    // ============================================================
    // POST /api/wallet/topup/inquiry
    // ============================================================
    topupInquiry: asyncHandler(async (req: Request, res: Response) => {
        const { amount, method, bank_code } = req.body;

        if (!amount || Number(amount) < 100)
            throw ApiError.badRequest('Minimal topup Rp10.000');
        if (method !== 'va' && method !== 'qris')
            throw ApiError.badRequest("Method harus 'va' atau 'qris'");
        if (method === 'va' && !bank_code)
            throw ApiError.badRequest('bank_code wajib untuk VA');

        const data = await walletService.topupInquiry(req.user!.id, {
            amount: Number(amount),
            method,
            bank_code,
        });
        return ok(res, data, 'Inquiry topup berhasil');
    }),

    // ============================================================
    // POST /api/wallet/topup/execute
    // ============================================================
    topupExecute: asyncHandler(async (req: Request, res: Response) => {
        const { partner_reff } = req.body;
        if (!partner_reff) throw ApiError.badRequest('partner_reff wajib');

        const data = await walletService.topupExecute(req.user!.id, partner_reff);
        return ok(res, data, 'Status topup diperbarui');
    }),

    // ============================================================
    // GET /api/wallet/topup/status/:partnerReff
    // ============================================================
    topupStatus: asyncHandler(async (req: Request, res: Response) => {
        const data = await walletService.topupStatus(
            req.user!.id,
            req.params.partnerReff
        );
        return ok(res, data);
    }),

    // ============================================================
    // POST /api/wallet/withdraw/inquiry
    // ============================================================
    withdrawInquiry: asyncHandler(async (req: Request, res: Response) => {
        const { amount, bank_code, account_number } = req.body;
        const role = resolveWalletRole(req);

        if (!amount || Number(amount) <= 0)
            throw ApiError.badRequest('Jumlah tidak valid');
        if (!bank_code || !account_number)
            throw ApiError.badRequest('Info bank tidak lengkap');

        const data = await walletService.withdrawInquiry(req.user!.id, {
            amount: Number(amount),
            bank_code,
            account_number,
            role,
        });
        return ok(res, data, 'Inquiry withdraw berhasil');
    }),

    // ============================================================
    // POST /api/wallet/withdraw/execute
    // ============================================================
    withdrawExecute: asyncHandler(async (req: Request, res: Response) => {
        const { inquiry_reff } = req.body;
        const role = resolveWalletRole(req);

        if (!inquiry_reff) throw ApiError.badRequest('inquiry_reff wajib');

        const data = await walletService.withdrawExecute(
            req.user!.id,
            inquiry_reff,
            role
        );
        return created(res, data, 'Penarikan sedang diproses');
    }),

    // ============================================================
    // SAVED ACCOUNTS
    // ============================================================
    listSavedAccounts: asyncHandler(async (req: Request, res: Response) => {
        const data = await walletService.listSavedAccounts(req.user!.id);
        return ok(res, data);
    }),

    saveAccount: asyncHandler(async (req: Request, res: Response) => {
        const { bank_code, account_number, account_name } = req.body;
        if (!bank_code || !account_number || !account_name)
            throw ApiError.badRequest('Data rekening tidak lengkap');

        const data = await walletService.saveAccount(req.user!.id, {
            bank_code,
            account_number,
            account_name,
        });
        return created(res, data, 'Rekening berhasil disimpan');
    }),

    deleteAccount: asyncHandler(async (req: Request, res: Response) => {
        const id = Number(req.params.id);
        if (!id || Number.isNaN(id)) throw ApiError.badRequest('ID tidak valid');

        await walletService.deleteAccount(req.user!.id, id);
        return ok(res, null, 'Rekening dihapus');
    }),
};