// src/modules/admin/admin.controller.ts
import { Request, Response } from 'express';
import { supabaseAdmin } from '../../config/supabase';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/response';
import * as svc from './admin.service';

// SESUAIKAN: bentuk req.user dari middleware requireAuth
const adminIdOf = (req: Request) => (req as any).user?.id as string | undefined;

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

export const adminController = {
    // ── Sudah ada ──
    listUsers: asyncHandler(async (req: Request, res: Response) => {
        const role = req.query.role as string | undefined;
        let q = supabaseAdmin.from('profiles').select('*').order('created_at', { ascending: false });
        if (role) q = q.eq('role', role);
        const { data } = await q;
        return ok(res, data);
    }),

    stats: asyncHandler(async (_req: Request, res: Response) => {
        const [{ count: users }, { count: drivers }, { count: merchants }, { count: orders }] =
            await Promise.all([
                supabaseAdmin.from('profiles').select('*', { count: 'exact', head: true }),
                supabaseAdmin.from('profiles').select('*', { count: 'exact', head: true }).eq('role', 'driver'),
                supabaseAdmin.from('profiles').select('*', { count: 'exact', head: true }).eq('role', 'merchant'),
                supabaseAdmin.from('orders').select('*', { count: 'exact', head: true }),
            ]);
        return ok(res, { users, drivers, merchants, orders });
    }),

    // Versi lama mengabaikan error; sekarang 404/500 benar-benar dikembalikan + dicatat
    verifyDriver: asyncHandler(async (req: Request, res: Response) => {
        await svc.verifyPartner('driver', req.params.id, adminIdOf(req));
        return ok(res, null, 'Driver verified');
    }),

    verifyMerchant: asyncHandler(async (req: Request, res: Response) => {
        await svc.verifyPartner('merchant', req.params.id, adminIdOf(req));
        return ok(res, null, 'Merchant verified');
    }),

    // ── Beranda ──
    dashboard: asyncHandler(async (_req: Request, res: Response) => {
        return ok(res, await svc.getDashboard());
    }),

    // ── Pesanan ──
    listOrders: asyncHandler(async (req: Request, res: Response) => {
        return ok(
            res,
            await svc.listOrders({
                status: str(req.query.status),
                search: str(req.query.search),
                limit: req.query.limit,
                offset: req.query.offset,
            })
        );
    }),

    getOrder: asyncHandler(async (req: Request, res: Response) => {
        return ok(res, await svc.getOrder(req.params.id));
    }),

    // ── Mitra ──
    listPartners: asyncHandler(async (req: Request, res: Response) => {
        const type = req.query.type === 'driver' ? 'driver' : 'merchant';
        return ok(
            res,
            await svc.listPartners({
                type,
                status: str(req.query.status),
                search: str(req.query.search),
                limit: req.query.limit,
                offset: req.query.offset,
            })
        );
    }),

    setPartnerSuspended: asyncHandler(async (req: Request, res: Response) => {
        const suspended = req.body?.suspended === true;
        await svc.setPartnerSuspended(req.params.id, suspended, adminIdOf(req));
        return ok(res, null, suspended ? 'Mitra ditangguhkan' : 'Mitra diaktifkan');
    }),

    // ── Keuangan ──
    financeSummary: asyncHandler(async (_req: Request, res: Response) => {
        return ok(res, await svc.getFinanceSummary());
    }),

    listWithdrawals: asyncHandler(async (req: Request, res: Response) => {
        return ok(
            res,
            await svc.listWithdrawals({
                source: str(req.query.source),
                status: str(req.query.status),
                limit: req.query.limit,
                offset: req.query.offset,
            })
        );
    }),

    approvePayout: asyncHandler(async (req: Request, res: Response) => {
        await svc.approvePayout(req.params.id, adminIdOf(req));
        return ok(res, null, 'Pengajuan disetujui');
    }),

    rejectPayout: asyncHandler(async (req: Request, res: Response) => {
        await svc.rejectPayout(req.params.id, str(req.body?.reason), adminIdOf(req));
        return ok(res, null, 'Pengajuan ditolak, dana dikembalikan ke saldo');
    }),

    listTopups: asyncHandler(async (req: Request, res: Response) => {
        return ok(
            res,
            await svc.listTopups({
                status: str(req.query.status),
                limit: req.query.limit,
                offset: req.query.offset,
            })
        );
    }),

    listCommissions: asyncHandler(async (req: Request, res: Response) => {
        return ok(res, await svc.listCommissions({ limit: req.query.limit, offset: req.query.offset }));
    }),

    // ── Akun ──
    listAdmins: asyncHandler(async (_req: Request, res: Response) => {
        return ok(res, await svc.listAdmins());
    }),

    listAuditLogs: asyncHandler(async (req: Request, res: Response) => {
        return ok(res, await svc.listAuditLogs({ limit: req.query.limit, offset: req.query.offset }));
    }),
};