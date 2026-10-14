// src/modules/assets/assets.service.ts
//
// Upload & kelola asset aplikasi (banner, icon, marker map, splash, dll).
// File disimpan di Supabase Storage bucket "app-assets".
// Metadata disimpan di tabel "asset_metadata" untuk listing & search.

import { supabaseAdmin as sb } from '../../config/supabase';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../config/logger';

const BUCKET = 'app-assets';
const T = 'asset_metadata';

// ─────────────────────────────────────────────────────────────
// Tipe
// ─────────────────────────────────────────────────────────────
export type AssetCategory =
    | 'banner'
    | 'icon'
    | 'marker'
    | 'splash'
    | 'other';

export type AssetRow = {
    id: number;
    key: string;
    category: AssetCategory;
    file_path: string;
    public_url: string;
    mime_type: string | null;
    file_size: number | null;
    width: number | null;
    height: number | null;
    label: string | null;
    is_active: boolean;
    created_at: string;
    updated_at: string;
    created_by: string | null;
};

const ALLOWED_CATEGORIES: AssetCategory[] = [
    'banner',
    'icon',
    'marker',
    'splash',
    'other',
];

const MIME_EXT: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/gif': 'gif',
};

const MAX_SIZE = 5 * 1024 * 1024; // 5 MB

// ─────────────────────────────────────────────────────────────
// Util
// ─────────────────────────────────────────────────────────────
const num = (v: any) => Number(v) || 0;

/** Slug: huruf kecil, angka, underscore. Sisanya jadi "_". */
function slugify(input: string): string {
    return input
        .toLowerCase()
        .trim()
        .replace(/\.[^.]+$/, '') // buang ekstensi
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60);
}

/** Timestamp + random pendek supaya unik. */
function uniqueSuffix(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function extFromMime(mime: string, fallback = 'bin'): string {
    return MIME_EXT[mime] ?? fallback;
}

function dbError(label: string, error: { message: string }) {
    logger.error(`[ASSETS] ${label} gagal`, { error: error.message });
    return ApiError.internal(`${label}: ${error.message}`);
}

// ─────────────────────────────────────────────────────────────
// LIST
// ─────────────────────────────────────────────────────────────
export async function listAssets(opts: {
    category?: string;
    search?: string;
    activeOnly?: boolean;
    limit?: any;
    offset?: any;
}) {
    const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
    const offset = Math.max(Number(opts.offset) || 0, 0);

    let q = sb
        .from(T)
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    if (opts.category && ALLOWED_CATEGORIES.includes(opts.category as any)) {
        q = q.eq('category', opts.category);
    }
    if (opts.activeOnly) {
        q = q.eq('is_active', true);
    }
    if (opts.search) {
        const term = opts.search.replace(/[%_,()*\\]/g, '').trim();
        if (term) {
            q = q.or(
                `key.ilike.%${term}%,label.ilike.%${term}%,category.ilike.%${term}%`
            );
        }
    }

    const { data, error, count } = await q;
    if (error) throw dbError('list', error);

    return {
        items: (data ?? []) as AssetRow[],
        total: count ?? 0,
        limit,
        offset,
    };
}

// ─────────────────────────────────────────────────────────────
// GET BY ID
// ─────────────────────────────────────────────────────────────
export async function getAsset(id: number) {
    const { data, error } = await sb
        .from(T)
        .select('*')
        .eq('id', id)
        .maybeSingle();
    if (error) throw dbError('getById', error);
    if (!data) throw ApiError.notFound('Asset tidak ditemukan');
    return data as AssetRow;
}

// ─────────────────────────────────────────────────────────────
// UPLOAD
// ─────────────────────────────────────────────────────────────
export async function uploadAsset(input: {
    file: {
        originalname: string;
        mimetype: string;
        buffer: Buffer;
        size: number;
    };
    category: AssetCategory;
    key?: string;
    label?: string;
    width?: number;
    height?: number;
    adminId?: string;
}) {
    const { file, category, adminId } = input;

    // ── Validasi kategori ──
    if (!ALLOWED_CATEGORIES.includes(category)) {
        throw ApiError.badRequest(
            `Kategori tidak valid. Pilihan: ${ALLOWED_CATEGORIES.join(', ')}`
        );
    }

    // ── Validasi file ──
    if (!file?.buffer?.length) {
        throw ApiError.badRequest('File wajib diisi');
    }
    if (file.size > MAX_SIZE) {
        throw ApiError.badRequest(
            `Ukuran file maksimal ${MAX_SIZE / 1024 / 1024} MB`
        );
    }
    if (!MIME_EXT[file.mimetype]) {
        throw ApiError.badRequest(
            `Tipe file tidak didukung: ${file.mimetype}. ` +
            `Gunakan: ${Object.keys(MIME_EXT).join(', ')}`
        );
    }

    // ── Buat key unik ──
    const rawKey = input.key?.trim() || file.originalname;
    const baseSlug = slugify(rawKey) || 'asset';
    const key = `${baseSlug}_${uniqueSuffix()}`;

    const ext = extFromMime(file.mimetype, 'bin');
    const filePath = `${category}/${key}.${ext}`;

    // ── Upload ke Supabase Storage ──
    const { error: upErr } = await sb.storage
        .from(BUCKET)
        .upload(filePath, file.buffer, {
            contentType: file.mimetype,
            upsert: false, // key sudah unik, tidak perlu upsert
            cacheControl: '31536000', // cache 1 tahun (asset statis)
        });

    if (upErr) {
        logger.error('[ASSETS] upload storage gagal', {
            error: upErr.message,
            path: filePath,
        });
        throw ApiError.internal(`Upload gagal: ${upErr.message}`);
    }

    // ── Ambil public URL ──
    const { data: urlData } = sb.storage
        .from(BUCKET)
        .getPublicUrl(filePath);
    const publicUrl = urlData.publicUrl;

    // ── Insert metadata ──
    const { data: row, error: dbErr } = await sb
        .from(T)
        .insert({
            key,
            category,
            file_path: filePath,
            public_url: publicUrl,
            mime_type: file.mimetype,
            file_size: file.size,
            width: input.width ?? null,
            height: input.height ?? null,
            label: input.label ?? null,
            is_active: true,
            created_by: adminId ?? null,
        })
        .select()
        .single();

    if (dbErr || !row) {
        // Rollback: hapus file yang sudah diupload
        logger.error('[ASSETS] insert metadata gagal, rollback file', {
            error: dbErr?.message,
            path: filePath,
        });
        await sb.storage.from(BUCKET).remove([filePath]);
        throw dbError('insert metadata', dbErr ?? { message: 'unknown' });
    }

    logger.info('[ASSETS] upload sukses', {
        id: row.id,
        key,
        category,
        size: file.size,
    });

    return row as AssetRow;
}

// ─────────────────────────────────────────────────────────────
// UPDATE METADATA (label, is_active, key)
// ─────────────────────────────────────────────────────────────
export async function updateAsset(
    id: number,
    patch: {
        label?: string | null;
        is_active?: boolean;
        key?: string;
    }
) {
    const update: Record<string, any> = {};
    if (patch.label !== undefined) update.label = patch.label;
    if (patch.is_active !== undefined) update.is_active = patch.is_active;
    if (patch.key !== undefined && patch.key.trim()) {
        update.key = slugify(patch.key);
    }

    if (Object.keys(update).length === 0) {
        throw ApiError.badRequest('Tidak ada field yang diubah');
    }

    const { data, error } = await sb
        .from(T)
        .update(update)
        .eq('id', id)
        .select()
        .maybeSingle();

    if (error) throw dbError('update', error);
    if (!data) throw ApiError.notFound('Asset tidak ditemukan');

    logger.info('[ASSETS] update sukses', { id, patch: update });
    return data as AssetRow;
}

// ─────────────────────────────────────────────────────────────
// GANTI FILE (replace) — tanpa ubah key
// ─────────────────────────────────────────────────────────────
export async function replaceAssetFile(
    id: number,
    file: {
        originalname: string;
        mimetype: string;
        buffer: Buffer;
        size: number;
    }
) {
    const existing = await getAsset(id);

    if (file.size > MAX_SIZE) {
        throw ApiError.badRequest(
            `Ukuran file maksimal ${MAX_SIZE / 1024 / 1024} MB`
        );
    }
    if (!MIME_EXT[file.mimetype]) {
        throw ApiError.badRequest(
            `Tipe file tidak didukung: ${file.mimetype}`
        );
    }

    const ext = extFromMime(file.mimetype, 'bin');
    const newPath = `${existing.category}/${existing.key}_${uniqueSuffix()}.${ext}`;

    // Upload file baru
    const { error: upErr } = await sb.storage
        .from(BUCKET)
        .upload(newPath, file.buffer, {
            contentType: file.mimetype,
            upsert: false,
            cacheControl: '31536000',
        });

    if (upErr) throw ApiError.internal(`Upload gagal: ${upErr.message}`);

    const { data: urlData } = sb.storage
        .from(BUCKET)
        .getPublicUrl(newPath);
    const newUrl = urlData.publicUrl;

    // Update metadata
    const { data: row, error: dbErr } = await sb
        .from(T)
        .update({
            file_path: newPath,
            public_url: newUrl,
            mime_type: file.mimetype,
            file_size: file.size,
        })
        .eq('id', id)
        .select()
        .single();

    if (dbErr || !row) {
        // Rollback: hapus file baru
        await sb.storage.from(BUCKET).remove([newPath]);
        throw dbError('replace', dbErr ?? { message: 'unknown' });
    }

    // Hapus file lama (best-effort)
    try {
        await sb.storage.from(BUCKET).remove([existing.file_path]);
    } catch (e: any) {
        logger.warn('[ASSETS] hapus file lama gagal', {
            error: e?.message,
            oldPath: existing.file_path,
        });
    }

    logger.info('[ASSETS] replace sukses', { id, newPath });
    return row as AssetRow;
}

// ─────────────────────────────────────────────────────────────
// DELETE (soft delete metadata + hapus file)
// ─────────────────────────────────────────────────────────────
export async function deleteAsset(id: number, hard = false) {
    const existing = await getAsset(id);

    if (hard) {
        // Hapus file dari storage
        try {
            await sb.storage.from(BUCKET).remove([existing.file_path]);
        } catch (e: any) {
            logger.warn('[ASSETS] hapus file storage gagal', {
                error: e?.message,
                path: existing.file_path,
            });
        }

        // Hapus metadata
        const { error } = await sb.from(T).delete().eq('id', id);
        if (error) throw dbError('delete', error);

        logger.info('[ASSETS] hard delete sukses', { id });
    } else {
        // Soft delete: set is_active=false
        const { error } = await sb
            .from(T)
            .update({ is_active: false })
            .eq('id', id);
        if (error) throw dbError('soft delete', error);

        logger.info('[ASSETS] soft delete sukses', { id });
    }
}

// ─────────────────────────────────────────────────────────────
// STATS
// ─────────────────────────────────────────────────────────────
export async function getAssetStats() {
    const { data, error } = await sb.from(T).select('category, file_size, is_active');
    if (error) throw dbError('stats', error);

    const rows = data ?? [];
    const totalSize = rows.reduce((s: number, r: any) => s + num(r.file_size), 0);

    const byCategory: Record<string, { count: number; size: number }> = {};
    rows.forEach((r: any) => {
        const c = r.category ?? 'other';
        if (!byCategory[c]) byCategory[c] = { count: 0, size: 0 };
        byCategory[c].count++;
        byCategory[c].size += num(r.file_size);
    });

    return {
        total: rows.length,
        active: rows.filter((r: any) => r.is_active).length,
        inactive: rows.filter((r: any) => !r.is_active).length,
        total_size: totalSize,
        by_category: byCategory,
    };
}

// src/modules/assets/assets.service.ts
export async function listPublicAssets(opts: {
    category?: string;
    limit?: number;
}) {
    const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 100);

    let q = sb
        .from(T)
        .select('id, key, category, public_url, width, height, label')
        .eq('is_active', true)
        .order('created_at', { ascending: false })   // terbaru dulu
        .limit(limit);

    if (
        opts.category &&
        ALLOWED_CATEGORIES.includes(opts.category as any)
    ) {
        q = q.eq('category', opts.category);
    }

    const { data, error } = await q;
    if (error) throw dbError('listPublic', error);

    return {
        items: (data ?? []).map((a: any) => ({
            id: a.id,
            key: a.key,
            category: a.category,
            url: a.public_url,
            width: a.width,
            height: a.height,
            label: a.label,
        })),
    };
}

// ─────────────────────────────────────────────────────────────
// BULK UPLOAD (multiple files sekaligus)
// ─────────────────────────────────────────────────────────────
export async function bulkUploadAssets(input: {
    files: Array<{
        originalname: string;
        mimetype: string;
        buffer: Buffer;
        size: number;
    }>;
    category: AssetCategory;
    adminId?: string;
}) {
    const results: Array<
        | { ok: true; asset: AssetRow }
        | { ok: false; filename: string; error: string }
    > = [];

    for (const file of input.files) {
        try {
            const asset = await uploadAsset({
                file,
                category: input.category,
                adminId: input.adminId,
            });
            results.push({ ok: true, asset });
        } catch (e: any) {
            results.push({
                ok: false,
                filename: file.originalname,
                error: e?.message ?? 'unknown',
            });
        }
    }

    return {
        total: input.files.length,
        success: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        results,
    };
}