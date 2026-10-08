import { Response } from 'express';

export const ok = (res: Response, data: any, message = 'OK') =>
    res.status(200).json({ success: true, message, data });

export const created = (res: Response, data: any, message = 'Created') =>
    res.status(201).json({ success: true, message, data });

export const fail = (res: Response, statusCode: number, message: string) =>
    res.status(statusCode).json({ success: false, message });