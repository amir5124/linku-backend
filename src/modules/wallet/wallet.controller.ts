// src/modules/wallet/wallet.controller.ts
import { Request, Response, NextFunction } from 'express';
import { walletService, type WalletType } from './wallet.service';
import { merchantWalletService } from './merchant-wallet.service';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok, created } from '../../utils/response';
import { ApiError } from '../../utils/ApiError';


// ============================================================
// Helper: role user untuk wallet (BACA — getWallet / ledger)
// ============================================================
function resolveWalletRole(req: Request): 'driver' | 'customer' {
    return req.user?.role === 'driver' ? 'driver' : 'customer';
}

// ============================================================
// Helper: dompet tujuan untuk TOPUP & WITHDRAW (UANG MASUK/KELUAR)
//
// Dompet SELALU ditentukan dari role akun yang login (token),
// tidak pernah dari body request. Nilainya disimpan di baris
// wallet_topups / wallet_withdrawals, jadi callback dan execute
// memakai dompet yang sama dengan saat inquiry.
//
// Merchant punya dompet sendiri (merchant_wallets). Top up & withdraw
// merchant belum lewat endpoint ini, jadi ditolak supaya uangnya tidak
// masuk ke dompet customer yang salah.
// ============================================================
function resolveMoneyWalletType(req: Request): WalletType {
    const role = req.user?.role;
    if (role === 'driver') return 'driver';
    if (role === 'customer') return 'customer';
    throw ApiError.badRequest(
        'Top up dan penarikan untuk akun ini belum tersedia lewat endpoint ini'
    );
}

export const walletController = {
    // ============================================================
    // GET /api/wallet
    // ============================================================
    getWallet: asyncHandler(async (req: Request, res: Response) => {
        const userId = req.user!.id;

        // Merchant punya tabel sendiri (merchant_wallets): saldo + utang komisi
        if (req.user?.role === 'merchant') {
            return ok(res, await merchantWalletService.getWallet(userId));
        }

        const data =
            req.user?.role === 'driver'
                ? await walletService.getWallet(userId, 'driver')
                : await walletService.getWallet(userId, 'customer');
        return ok(res, data);
    }),

    // ============================================================
    // GET /api/wallet/ledger
    // ============================================================
    listLedger: asyncHandler(async (req: Request, res: Response) => {
        const limit = Number(req.query.limit ?? 50);
        const offset = Number(req.query.offset ?? 0);
        const userId = req.user!.id;

        // Merchant: riwayat dari merchant_wallet_ledger
        if (req.user?.role === 'merchant') {
            return ok(
                res,
                await merchantWalletService.listLedger(userId, limit, offset)
            );
        }

        const role = resolveWalletRole(req);
        const data =
            role === 'driver'
                ? await walletService.listLedger(userId, limit, offset)
                : await walletService.listLedgerCustomer(userId, limit, offset);

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
        const {
            amount,
            bank_code,
            bank_name,
            account_number,
            account_name,
        } = req.body;

        if (!amount || amount <= 0)
            throw ApiError.badRequest('Jumlah tidak valid');
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
        const walletType = resolveMoneyWalletType(req); // ← dari role, bukan body

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
            walletType,
        });
        return ok(res, data, 'Inquiry topup berhasil');
    }),

    // ============================================================
    // POST /api/wallet/topup/execute
    // ============================================================
    topupExecute: asyncHandler(async (req: Request, res: Response) => {
        const { partner_reff } = req.body;
        if (!partner_reff) throw ApiError.badRequest('partner_reff wajib');

        const data = await walletService.topupExecute(
            req.user!.id,
            partner_reff
        );
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
        const walletType = resolveMoneyWalletType(req); // ← dari role, bukan body

        if (!amount || Number(amount) <= 0)
            throw ApiError.badRequest('Jumlah tidak valid');
        if (!bank_code || !account_number)
            throw ApiError.badRequest('Info bank tidak lengkap');

        const data = await walletService.withdrawInquiry(req.user!.id, {
            amount: Number(amount),
            bank_code,
            account_number,
            walletType,
        });
        return ok(res, data, 'Inquiry withdraw berhasil');
    }),

    // ============================================================
    // POST /api/wallet/withdraw/execute
    // Dompet diambil dari baris inquiry (wallet_type), bukan dari request.
    // ============================================================
    withdrawExecute: asyncHandler(async (req: Request, res: Response) => {
        const { inquiry_reff } = req.body;
        resolveMoneyWalletType(req); // tolak role yang belum didukung

        if (!inquiry_reff) throw ApiError.badRequest('inquiry_reff wajib');

        const data = await walletService.withdrawExecute(
            req.user!.id,
            inquiry_reff
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
        if (!id || Number.isNaN(id))
            throw ApiError.badRequest('ID tidak valid');

        await walletService.deleteAccount(req.user!.id, id);
        return ok(res, null, 'Rekening dihapus');
    }),

    // ============================================================
    // HISTORY TOPUP
    // GET /api/wallet/topups?limit=20&offset=0&status=SUCCESS
    // ============================================================
    listTopups: asyncHandler(async (req: Request, res: Response) => {
        const limit = Number(req.query.limit ?? 20);
        const offset = Number(req.query.offset ?? 0);
        const status = req.query.status as string | undefined;

        const data = await walletService.listTopups(
            req.user!.id,
            limit,
            offset,
            status
        );
        return ok(res, data, 'Topup history');
    }),

    // ============================================================
    // HISTORY WITHDRAWAL
    // GET /api/wallet/withdrawals?limit=20&offset=0&status=SUCCESS
    // ============================================================
    listWithdrawals: asyncHandler(async (req: Request, res: Response) => {
        const limit = Number(req.query.limit ?? 20);
        const offset = Number(req.query.offset ?? 0);
        const status = req.query.status as string | undefined;

        const data = await walletService.listWithdrawals(
            req.user!.id,
            limit,
            offset,
            status
        );
        return ok(res, data, 'Withdraw history');
    }),

    // ============================================================
    // HISTORY TRANSACTIONS (gabungan)
    // GET /api/wallet/transactions?limit=20&offset=0
    // ============================================================
    listTransactions: asyncHandler(async (req: Request, res: Response) => {
        const limit = Number(req.query.limit ?? 20);
        const offset = Number(req.query.offset ?? 0);

        const data = await walletService.listTransactions(
            req.user!.id,
            limit,
            offset
        );
        return ok(res, data, 'Transaction history');
    }),

    getMerchantEligibility: async (req: Request, res: Response, next: NextFunction) => {
        try {
            const data = await merchantWalletService.getEligibility(req.user!.id);
            res.json({ success: true, data });
        } catch (e) {
            next(e);
        }
    },
};