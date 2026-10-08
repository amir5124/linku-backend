import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface JwtPayload {
    sub: string;
    role: 'customer' | 'driver' | 'merchant' | 'admin';
    email?: string;
}

export const signJwt = (payload: JwtPayload) =>
    jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtExpiresIn as any });

export const verifyJwt = (token: string): JwtPayload =>
    jwt.verify(token, env.jwtSecret) as JwtPayload;