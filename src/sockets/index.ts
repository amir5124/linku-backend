import { Server as HTTPServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { env } from '../config/env';
import { verifyJwt } from '../utils/jwt';
import { logger } from '../config/logger';

let io: SocketServer | null = null;

export const initSocket = (httpServer: HTTPServer) => {
    io = new SocketServer(httpServer, {
        cors: { origin: env.socketCorsOrigin, credentials: true },
    });

    // Namespace tunggal — role dipisahkan lewat room
    const appNs = io.of('/app');

    appNs.use((socket, next) => {
        try {
            const token = socket.handshake.auth.token;
            if (!token) return next(new Error('No token'));
            const payload = verifyJwt(token);
            (socket as any).user = { id: payload.sub, role: payload.role };
            next();
        } catch (err) {
            next(new Error('Invalid token'));
        }
    });

    appNs.on('connection', (socket) => {
        const user = (socket as any).user;
        socket.join(`user:${user.id}`);
        socket.join(`role:${user.role}`);
        logger.info(`Socket connected: ${user.id} (${user.role})`);

        socket.on('order:subscribe', (orderId: number) => {
            socket.join(`order:${orderId}`);
        });
        socket.on('order:unsubscribe', (orderId: number) => {
            socket.leave(`order:${orderId}`);
        });

        socket.on('chat:join', (roomId: number) => {
            socket.join(`chat:${roomId}`);
        });

        socket.on('chat:send', async ({ roomId, message }) => {
            // Simpan lewat chatService agar konsisten
            const { chatService } = await import('../modules/chat/chat.service');
            const saved = await chatService.sendMessage(roomId, user.id, message);
            appNs.to(`chat:${roomId}`).emit('chat:new', saved);
        });

        socket.on('disconnect', () => {
            logger.info(`Socket disconnected: ${user.id}`);
        });
    });

    return io;
};

export const getIO = () => io;