// src/modules/assets/assets.controller.ts
import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/response';
import { ApiError } from '../../utils/ApiError';
import * as svc from './assets.service';
import type { AssetCategory } from './assets.service';

const adminIdOf = (req: Request) =>
    (req as any).user?.id as string | undefined;

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const bool = (v: unknown) =>
    v === 'true' || v === true ? true : v === 'false' || v === false ? false : undefined;

// File dari multer: req.file / req.files
const fileOf = (req: Request) => {
    const f = (req as any).file;
    if (!f) return null;
    return {
        originalname: f.originalname,
        mimetype: f.mimetype,
        buffer: f.buffer,
        size: f.size,
    };
};

const filesOf = (req: Request) => {
    const fs = (req as any).files;
    if (!Array.isArray(fs)) return [];
    return fs.map((f: any) => ({
        originalname: f.originalname,
        mimetype: f.mimetype,
        buffer: f.buffer,
        size: f.size,
    }));
};

const parseCategory = (v: unknown): AssetCategory => {
    const s = String(v ?? '').toLowerCase();
    if (
        s === 'banner' ||
        s === 'icon' ||
        s === 'marker' ||
        s === 'splash' ||
        s === 'other'
    ) {
        return s;
    }
    throw ApiError.badRequest(`Kategori tidak valid: ${v}`);
};

export const assetsController = {
    // GET /api/admin/assets
    list: asyncHandler(async (req: Request, res: Response) => {
        return ok(
            res,
            await svc.listAssets({
                category: str(req.query.category),
                search: str(req.query.search),
                activeOnly: bool(req.query.active_only),
                limit: req.query.limit,
                offset: req.query.offset,
            })
        );
    }),

    listPublic: asyncHandler(async (req: Request, res: Response) => {
        const category = typeof req.query.category === 'string'
            ? req.query.category
            : undefined;

        const result = await svc.listPublicAssets({
            category,
            limit: req.query.limit ? Number(req.query.limit) : 20,
        });
        return ok(res, result);
    }),

    // GET /api/admin/assets/:id
    getById: asyncHandler(async (req: Request, res: Response) => {
        return ok(res, await svc.getAsset(Number(req.params.id)));
    }),

    // GET /api/admin/assets/stats
    stats: asyncHandler(async (_req: Request, res: Response) => {
        return ok(res, await svc.getAssetStats());
    }),

    // POST /api/admin/assets
    // multipart: file=<binary>, category=banner|icon|marker|splash|other,
    //            key?, label?, width?, height?
    upload: asyncHandler(async (req: Request, res: Response) => {
        const file = fileOf(req);
        if (!file) throw ApiError.badRequest('File wajib diisi');

        const category = parseCategory(req.body?.category);
        const asset = await svc.uploadAsset({
            file,
            category,
            key: str(req.body?.key),
            label: str(req.body?.label),
            width: req.body?.width ? Number(req.body.width) : undefined,
            height: req.body?.height ? Number(req.body.height) : undefined,
            adminId: adminIdOf(req),
        });
        return ok(res, asset, 'Asset berhasil diupload');
    }),

    // POST /api/admin/assets/bulk
    // multipart: files=<binary[]>, category=...
    bulkUpload: asyncHandler(async (req: Request, res: Response) => {
        const files = filesOf(req);
        if (!files.length) throw ApiError.badRequest('Minimal 1 file wajib diisi');

        const category = parseCategory(req.body?.category);
        const result = await svc.bulkUploadAssets({
            files,
            category,
            adminId: adminIdOf(req),
        });
        return ok(res, result, `${result.success} dari ${result.total} file berhasil diupload`);
    }),

    // PUT /api/admin/assets/:id
    update: asyncHandler(async (req: Request, res: Response) => {
        const asset = await svc.updateAsset(Number(req.params.id), {
            label: req.body?.label,
            is_active: bool(req.body?.is_active),
            key: str(req.body?.key),
        });
        return ok(res, asset, 'Asset diperbarui');
    }),

    // PUT /api/admin/assets/:id/replace
    // multipart: file=<binary>
    replaceFile: asyncHandler(async (req: Request, res: Response) => {
        const file = fileOf(req);
        if (!file) throw ApiError.badRequest('File wajib diisi');

        const asset = await svc.replaceAssetFile(Number(req.params.id), file);
        return ok(res, asset, 'File asset berhasil diganti');
    }),

    // DELETE /api/admin/assets/:id?hard=true|false
    remove: asyncHandler(async (req: Request, res: Response) => {
        const hard = bool(req.query.hard) ?? false;
        await svc.deleteAsset(Number(req.params.id), hard);
        return ok(
            res,
            null,
            hard ? 'Asset dihapus permanen' : 'Asset dinonaktifkan'
        );
    }),
};