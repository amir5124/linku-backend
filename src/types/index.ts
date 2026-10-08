export type UserRole = 'customer' | 'driver' | 'merchant' | 'admin';
export type OrderType = 'ride' | 'food' | 'send';
export type OrderStatus =
    | 'pending'
    | 'accepted'
    | 'arrived'
    | 'in_progress'
    | 'completed'
    | 'cancelled';

export interface AuthUser {
    id: string;
    role: UserRole;
    email?: string;
}

declare global {
    namespace Express {
        interface Request {
            user?: AuthUser;
        }
    }
}