import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import { env } from './config/env';
import { logger } from './config/logger';
import { initSocket } from './sockets';
import { startJobs } from './jobs';
import { apiLimiter } from './middleware/rateLimit';
import { errorHandler, notFound } from './middleware/errorHandler';

import authRoutes from './modules/auth/auth.routes';
import driverRoutes from './modules/driver/driver.routes';
import merchantRoutes from './modules/merchant/merchant.routes';
import menuRoutes from './modules/menu/menu.routes';
import orderRoutes from './modules/order/order.routes';
import chatRoutes from './modules/chat/chat.routes';
import notificationRoutes from './modules/notification/notification.routes';
import adminRoutes from './modules/admin/admin.routes';
import profileRoutes from './modules/profile/profile.routes';
import savedAddressRoutes from './modules/saved-address/saved-address.routes';
import tariffRoutes from './modules/tariff/tariff.routes';
import ratingRoutes from './modules/rating/rating.routes';
import activityRoutes from './modules/activity/activity.routes';
import walletRoutes from './modules/wallet/wallet.routes';
import walletCallbackRouter from './modules/wallet/wallet.callback';  // ← TAMBAH INI
import merchantRouter from './modules/merchant/merchant.routes';
import uploadRoutes from './modules/upload/upload.routes';


import { orderTimeoutService } from './modules/order/order-timeout.service';

const app = express();

app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: env.socketCorsOrigin }));
app.use(express.json({ limit: '2mb' }));
app.use(apiLimiter);

app.get('/health', (_req, res) =>
    res.json({ ok: true, service: 'ojek-backend', time: new Date().toISOString() })
);

app.use('/api/auth', authRoutes);
app.use('/api/profiles', profileRoutes);
app.use('/api/drivers', driverRoutes);
app.use('/api/merchants', merchantRoutes);
app.use('/api/menus', menuRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/saved-addresses', savedAddressRoutes);
app.use('/api/tariffs', tariffRoutes);
app.use('/api/ratings', ratingRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/upload', uploadRoutes);

// ============================================================
// CALLBACK LINKQU — tanpa auth (didaftarkan DULUAN)
// URL: https://warung.siappgo.id/api/wallet/callback
// ============================================================
app.use('/api/wallet', walletCallbackRouter);

// ============================================================
// WALLET ROUTES — butuh auth (didaftarkan SETELAH callback)
// ============================================================
app.use('/api/wallet', walletRoutes);

app.use('/api/merchant', merchantRouter);

app.use(notFound);
app.use(errorHandler);

const httpServer = createServer(app);
initSocket(httpServer);

startJobs();

// Cek order pending tiap 1 menit
orderTimeoutService.start(60_000);

httpServer.listen(env.port, () => {
    logger.info(`Server running on port ${env.port}`);
});