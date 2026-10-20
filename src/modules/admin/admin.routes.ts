// src/modules/admin/admin.routes.ts
import { Router } from 'express';
import { adminController } from './admin.controller';
import { requireAuth, requireRole } from '../../middleware/auth';
import settingsAdminRoutes from '../settings/admin.routes';
import commissionRoutes from '../commission/commission.routes';



const router = Router();
router.use(requireAuth, requireRole('admin'));

router.use('/settings', settingsAdminRoutes);
router.use('/commission-rates', commissionRoutes);


// Beranda
router.get('/stats', adminController.stats);
router.get('/dashboard', adminController.dashboard);

router.get('/accounts/summary', adminController.accountsSummary);
router.get('/accounts', adminController.listAccounts);
router.get('/accounts/:id', adminController.getAccount);
router.post('/accounts/:id/adjust-balance', adminController.adjustBalance);

// Pesanan
router.get('/orders', adminController.listOrders);
router.get('/orders/:id', adminController.getOrder);

// Mitra
router.get('/users', adminController.listUsers);
router.get('/partners', adminController.listPartners);
router.put('/partners/:id/suspend', adminController.setPartnerSuspended);
router.put('/drivers/:id/verify', adminController.verifyDriver);
router.put('/merchants/:id/verify', adminController.verifyMerchant);

// Keuangan
router.get('/finance/summary', adminController.financeSummary);
router.get('/finance/withdrawals', adminController.listWithdrawals);
router.put('/finance/payouts/:id/approve', adminController.approvePayout);
router.put('/finance/payouts/:id/reject', adminController.rejectPayout);
router.get('/finance/topups', adminController.listTopups);
router.get('/finance/commissions', adminController.listCommissions);

// Akun
router.get('/admins', adminController.listAdmins);
router.get('/audit-logs', adminController.listAuditLogs);

export default router;