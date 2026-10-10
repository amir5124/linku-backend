// src/modules/wallet/wallet.routes.ts
import { Router } from 'express';
import { walletController } from './wallet.controller';
import { requireAuth, requireRole } from '../../middleware/auth';

const router = Router();

router.use(requireAuth);

// ============================================================
// ENDPOINT UMUM (customer + driver)
// ============================================================
router.get('/', walletController.getWallet);
router.get('/ledger', walletController.listLedger);
router.get('/history', walletController.listLedger); // alias lama

// ============================================================
// 🆕 HISTORY TRANSAKSI
// ============================================================
router.get('/topups', walletController.listTopups);
router.get('/withdrawals', walletController.listWithdrawals);
router.get('/transactions', walletController.listTransactions);

// ============================================================
// TOPUP via LinkQu (VA/QRIS)
// ============================================================
router.post('/topup/inquiry', walletController.topupInquiry);
router.post('/topup/execute', walletController.topupExecute);
router.get('/topup/status/:partnerReff', walletController.topupStatus);

// ============================================================
// WITHDRAW via LinkQu
// ============================================================
router.post('/withdraw/inquiry', walletController.withdrawInquiry);
router.post('/withdraw/execute', walletController.withdrawExecute);

// ============================================================
// REKENING TERSIMPAN (maks 2)
// ============================================================
router.get('/saved-accounts', walletController.listSavedAccounts);
router.post('/saved-accounts', walletController.saveAccount);
router.delete('/saved-accounts/:id', walletController.deleteAccount);

// ============================================================
// ENDPOINT KHUSUS DRIVER
// ============================================================
router.get('/payouts', requireRole('driver'), walletController.listPayouts);
router.post('/payouts', requireRole('driver'), walletController.requestPayout);

export default router;