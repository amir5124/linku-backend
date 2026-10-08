import { Request, Response } from 'express';
import { menuService } from './menu.service';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok, created } from '../../utils/response';

export const menuController = {
    list: asyncHandler(async (req: Request, res: Response) =>
        ok(res, await menuService.listByMerchant(req.params.merchantId))
    ),
    createCategory: asyncHandler(async (req: Request, res: Response) =>
        created(res, await menuService.createCategory(req.user!.id, req.body.name, req.body.sort_order))
    ),
    createItem: asyncHandler(async (req: Request, res: Response) =>
        created(res, await menuService.createItem(req.user!.id, req.body))
    ),
    updateItem: asyncHandler(async (req: Request, res: Response) =>
        ok(res, await menuService.updateItem(req.user!.id, Number(req.params.id), req.body))
    ),
    deleteItem: asyncHandler(async (req: Request, res: Response) => {
        await menuService.deleteItem(req.user!.id, Number(req.params.id));
        return ok(res, null, 'Deleted');
    }),
};