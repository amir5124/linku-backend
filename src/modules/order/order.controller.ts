import { Request, Response } from 'express';
import { orderService } from './order.service';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok, created } from '../../utils/response';
import { ApiError } from '../../utils/ApiError';

export const orderController = {
    create: asyncHandler(async (req: Request, res: Response) => {
        const data = await orderService.create(req.user!.id, req.body);
        return created(res, data, 'Order created');
    }),

    accept: asyncHandler(async (req: Request, res: Response) => {
        const data = await orderService.accept(
            Number(req.params.id),
            req.user!.id
        );
        return ok(res, data, 'Order accepted');
    }),

    // ⬇️ BARU: toko menerima pesanan makanan
    merchantAccept: asyncHandler(async (req: Request, res: Response) => {
        const data = await orderService.merchantRespond(
            Number(req.params.id),
            req.user!.id,
            true,
            { prep_minutes: req.body?.prep_minutes }
        );
        return ok(res, data, 'Pesanan diterima toko');
    }),

    // ⬇️ BARU: toko menolak pesanan makanan
    merchantReject: asyncHandler(async (req: Request, res: Response) => {
        const data = await orderService.merchantRespond(
            Number(req.params.id),
            req.user!.id,
            false,
            { reason: req.body?.reason }
        );
        return ok(res, data, 'Pesanan ditolak toko');
    }),

    merchantReady: asyncHandler(async (req: Request, res: Response) => {
        const data = await orderService.merchantMarkReady(
            Number(req.params.id),
            req.user!.id
        );
        return ok(res, data, 'Pesanan ditandai siap');
    }),

    updateStatus: asyncHandler(async (req: Request, res: Response) => {
        const orderId = Number(req.params.id);

        // Validasi send_code sebelum completed
        if (req.body.status === 'completed') {
            const order = await orderService.getById(
                orderId,
                req.user!.id,
                req.user!.role
            );

            if (order.type === 'send' && order.send_code) {
                if (req.body.send_code !== order.send_code) {
                    throw ApiError.badRequest('Kode terima paket tidak cocok');
                }
            }
        }

        const data = await orderService.updateStatus(
            orderId,
            req.user!.id,
            req.user!.role,
            req.body.status,
            req.body.reason
        );
        return ok(res, data, 'Status updated');
    }),

    detail: asyncHandler(async (req: Request, res: Response) => {
        const data = await orderService.getById(
            Number(req.params.id),
            req.user!.id,
            req.user!.role
        );
        return ok(res, data);
    }),

    list: asyncHandler(async (req: Request, res: Response) => {
        const data = await orderService.listByUser(
            req.user!.id,
            req.user!.role,
            req.query.status as string
        );
        return ok(res, data);
    }),

    uploadPackagePhoto: asyncHandler(async (req: Request, res: Response) => {
        if (!req.file) {
            throw ApiError.badRequest('File tidak ditemukan');
        }

        const data = await orderService.uploadPackagePhoto(
            Number(req.params.id),
            req.user!.id,
            req.file
        );

        return ok(res, data, 'Foto paket berhasil diunggah');
    }),

    confirmPurchase: asyncHandler(async (req: Request, res: Response) => {
        if (!req.file) {
            throw ApiError.badRequest('Foto struk / bukti belanja wajib diunggah');
        }

        let items: unknown;
        try {
            items = JSON.parse(String(req.body.items ?? '[]'));
        } catch {
            throw ApiError.badRequest('Format items tidak valid');
        }

        if (!Array.isArray(items) || items.length === 0) {
            throw ApiError.badRequest('Items pembelian wajib diisi');
        }

        // multipart mengirim semua field sebagai string
        const noReceipt =
            req.body.no_receipt === 'true' || req.body.no_receipt === '1';
        const noReceiptNote = req.body.no_receipt_note
            ? String(req.body.no_receipt_note)
            : undefined;

        const data = await orderService.confirmPurchase(
            Number(req.params.id),
            req.user!.id,
            {
                items,
                no_receipt: noReceipt,
                no_receipt_note: noReceiptNote,
            },
            req.file
        );

        return ok(res, data, 'Pembelian berhasil dikonfirmasi');
    }),
};