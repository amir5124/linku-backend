import { Request, Response } from 'express';
import { savedAddressService, SavedKind } from './saved-address.service';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok, created } from '../../utils/response';

export const savedAddressController = {
    list: asyncHandler(async (req: Request, res: Response) =>
        ok(res, await savedAddressService.list(req.user!.id))
    ),

    upsert: asyncHandler(async (req: Request, res: Response) => {
        const body = req.body;
        if (!body.kind || !body.name || !body.address || body.latitude == null || body.longitude == null) {
            return res.status(400).json({
                success: false,
                message: 'Field kind, name, address, latitude, longitude wajib diisi',
            });
        }
        const data = await savedAddressService.upsert(req.user!.id, body);
        return created(res, data, 'Saved address tersimpan');
    }),

    remove: asyncHandler(async (req: Request, res: Response) => {
        await savedAddressService.remove(req.user!.id, req.params.kind as SavedKind);
        return ok(res, null, 'Saved address dihapus');
    }),

    get: asyncHandler(async (req: Request, res: Response) => {
        const data = await savedAddressService.get(req.user!.id, req.params.kind as SavedKind);
        return ok(res, data);
    }),
};