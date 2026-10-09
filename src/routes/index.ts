import { Router } from "express";
import { asyncHandler } from "../middleware/error-handler.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin, requireAdminMfaPending, requireAdminModule, requireStaffManager } from "../middleware/admin.js";
import { authController } from "../modules/auth/controllers/auth.controller.js";
import { usersController } from "../modules/users/controllers/users.controller.js";
import { walletController } from "../modules/wallet/controllers/wallet.controller.js";
import { kycController } from "../modules/kyc/controllers/kyc.controller.js";
import { cardsController } from "../modules/cards/controllers/cards.controller.js";
import { cryptoController } from "../modules/crypto/controllers/crypto.controller.js";
import { billsController } from "../modules/bills/controllers/bills.controller.js";
import { esimController } from "../modules/esim/controllers/esim.controller.js";
import { webhooksController } from "../modules/webhooks/controllers/webhooks.controller.js";
import { fxController } from "../modules/fx/controllers/fx.controller.js";
import { depositsController } from "../modules/deposits/controllers/deposits.controller.js";
import { transfersController } from "../modules/transfers/controllers/transfers.controller.js";
import { floatJobsService } from "../modules/float/services/float-jobs.service.js";
import { simulateProviders } from "../lib/simulate.js";
import { ok } from "../lib/http.js";
import {
  adminAuthController,
  adminKillSwitchController,
  adminKycController,
  adminSupportController,
} from "../modules/admin/controllers/admin.controller.js";
import { adminListController } from "../modules/admin/controllers/admin-list.controller.js";
import { adminOpsController } from "../modules/admin/controllers/admin-ops.controller.js";
import { adminConsoleController } from "../modules/admin/controllers/admin-console.controller.js";
import { adminModulesController } from "../modules/admin/controllers/admin-modules.controller.js";
import { sessionsController } from "../modules/sessions/controllers/sessions.controller.js";
import { securityController } from "../modules/security/controllers/security.controller.js";
import { referralsController } from "../modules/referrals/controllers/referrals.controller.js";
import { supportController } from "../modules/support/controllers/support.controller.js";

export const apiRouter = Router();

apiRouter.get("/health", (_req, res) => {
  res.json({
    success: true,
    data: {
      service: "fulus-api",
      status: "ok",
      simulateProviders: simulateProviders(),
      providers: ["pagocards", "busha", "prembly", "strowallet", "esim-go", "flutterwave"],
    },
  });
});

apiRouter.post("/auth/register", asyncHandler(authController.register));
apiRouter.post("/auth/login", asyncHandler(authController.login));
apiRouter.post("/auth/forgot-password", asyncHandler(authController.forgotPassword));
apiRouter.post("/auth/verify-otp", asyncHandler(authController.verifyOtp));
apiRouter.post("/auth/resend-otp", asyncHandler(authController.resendOtp));
apiRouter.post("/auth/reset-password", asyncHandler(authController.resetPassword));

apiRouter.get("/me", requireAuth, asyncHandler(usersController.me));
apiRouter.patch("/me", requireAuth, asyncHandler(usersController.updateMe));
apiRouter.get("/avatars/:userId", asyncHandler(usersController.avatar));
apiRouter.post("/me/change-password", requireAuth, asyncHandler(usersController.changePassword));
apiRouter.post("/me/closure-request", requireAuth, asyncHandler(usersController.closureRequest));
apiRouter.get("/me/security", requireAuth, asyncHandler(securityController.get));
apiRouter.patch("/me/security", requireAuth, asyncHandler(securityController.patch));
apiRouter.get("/sessions", requireAuth, asyncHandler(sessionsController.list));
apiRouter.post("/sessions/revoke-all", requireAuth, asyncHandler(sessionsController.revokeAll));
apiRouter.post("/sessions/revoke-current", requireAuth, asyncHandler(sessionsController.revokeCurrent));
apiRouter.post("/sessions/:id/revoke", requireAuth, asyncHandler(sessionsController.revoke));
apiRouter.get("/referrals/me", requireAuth, asyncHandler(referralsController.me));
apiRouter.post("/support/tickets", requireAuth, asyncHandler(supportController.create));
apiRouter.get("/support/tickets", requireAuth, asyncHandler(supportController.list));
apiRouter.get("/support/tickets/:id", requireAuth, asyncHandler(supportController.get));
apiRouter.post("/support/tickets/:id/messages", requireAuth, asyncHandler(supportController.message));
apiRouter.get("/inbox", requireAuth, asyncHandler(usersController.inbox));
apiRouter.post("/inbox/:id/read", requireAuth, asyncHandler(usersController.markInboxRead));

apiRouter.get("/wallets", requireAuth, asyncHandler(walletController.list));
apiRouter.get("/wallets/deposit/bank/accounts", requireAuth, asyncHandler(depositsController.virtualAccount));
apiRouter.post("/wallets/demo-credit", requireAuth, asyncHandler(walletController.demoCredit));
apiRouter.get("/wallets/:currency", requireAuth, asyncHandler(walletController.getOne));
apiRouter.get("/transactions", requireAuth, asyncHandler(walletController.transactions));
apiRouter.get("/transactions/:id", requireAuth, asyncHandler(walletController.getTransaction));

apiRouter.get("/fx/rates", requireAuth, asyncHandler(fxController.listRates));
apiRouter.post("/fx/quote", requireAuth, asyncHandler(fxController.quote));
apiRouter.post("/wallets/swap", requireAuth, asyncHandler(fxController.swap));

apiRouter.get("/admin/fx/rates", requireAdmin, requireAdminModule, asyncHandler(fxController.adminList));
apiRouter.put("/admin/fx/rates", requireAdmin, requireAdminModule, asyncHandler(fxController.adminUpsert));
apiRouter.post("/admin/auth/login", asyncHandler(adminAuthController.login));
apiRouter.post("/admin/auth/mfa", requireAdminMfaPending, asyncHandler(adminAuthController.mfa));
apiRouter.get("/admin/auth/me", requireAdmin, requireAdminModule, asyncHandler(adminAuthController.me));
apiRouter.get("/admin/auth/mfa/status", requireAdmin, requireAdminModule, asyncHandler(adminAuthController.mfaStatus));
apiRouter.post("/admin/auth/mfa/setup", requireAdmin, requireAdminModule, asyncHandler(adminAuthController.mfaSetup));
apiRouter.post("/admin/auth/mfa/confirm", requireAdmin, requireAdminModule, asyncHandler(adminAuthController.mfaConfirm));
apiRouter.post("/admin/auth/mfa/disable", requireAdmin, requireAdminModule, asyncHandler(adminAuthController.mfaDisable));
apiRouter.post("/admin/auth/mfa/recovery-codes", requireAdmin, requireAdminModule, asyncHandler(adminAuthController.mfaRegenBackup));
apiRouter.post("/admin/staff/:id/mfa/reset", requireAdmin, requireAdminModule, asyncHandler(adminAuthController.mfaAdminReset));
apiRouter.get("/admin/kyc/checks", requireAdmin, requireAdminModule, asyncHandler(adminKycController.list));
apiRouter.post("/admin/kyc/checks/:id/approve", requireAdmin, requireAdminModule, asyncHandler(adminKycController.approve));
apiRouter.post("/admin/kyc/checks/:id/reject", requireAdmin, requireAdminModule, asyncHandler(adminKycController.reject));
apiRouter.get("/admin/kyc/checks/:id/evidence", requireAdmin, requireAdminModule, asyncHandler(adminKycController.evidence));
apiRouter.get("/admin/kill-switches", requireAdmin, requireAdminModule, asyncHandler(adminKillSwitchController.list));
apiRouter.put("/admin/kill-switches", requireAdmin, requireAdminModule, asyncHandler(adminKillSwitchController.put));
apiRouter.get("/admin/support/tickets", requireAdmin, requireAdminModule, asyncHandler(adminSupportController.list));
apiRouter.get("/admin/support/tickets/:id", requireAdmin, requireAdminModule, asyncHandler(adminSupportController.get));
apiRouter.post("/admin/support/tickets/:id/reply", requireAdmin, requireAdminModule, asyncHandler(adminSupportController.reply));
apiRouter.get("/admin/users", requireAdmin, requireAdminModule, asyncHandler(adminConsoleController.listCustomers));
apiRouter.get("/admin/users/:id", requireAdmin, requireAdminModule, asyncHandler(adminConsoleController.getCustomer));
apiRouter.post("/admin/users/:id/freeze", requireAdmin, requireAdminModule, asyncHandler(adminConsoleController.freezeUser));
apiRouter.post("/admin/users/:id/unfreeze", requireAdmin, requireAdminModule, asyncHandler(adminConsoleController.unfreezeUser));
apiRouter.post("/admin/users/:id/tier", requireAdmin, requireAdminModule, asyncHandler(adminConsoleController.setUserTier));
apiRouter.get("/admin/transactions", requireAdmin, requireAdminModule, asyncHandler(adminConsoleController.listMoneyTransactions));
apiRouter.get("/admin/transactions/:id", requireAdmin, requireAdminModule, asyncHandler(adminConsoleController.getMoneyTransaction));
apiRouter.get("/admin/deposits", requireAdmin, requireAdminModule, asyncHandler(adminListController.listDeposits));
apiRouter.get("/admin/payouts", requireAdmin, requireAdminModule, asyncHandler(adminListController.listPayouts));
apiRouter.get("/admin/cards", requireAdmin, requireAdminModule, asyncHandler(adminListController.listCards));
apiRouter.get("/admin/overview", requireAdmin, requireAdminModule, asyncHandler(adminConsoleController.overview));
apiRouter.get("/admin/overview/flow", requireAdmin, requireAdminModule, asyncHandler(adminConsoleController.overviewFlow));
apiRouter.get("/admin/overview/rails", requireAdmin, requireAdminModule, asyncHandler(adminConsoleController.overviewRails));
apiRouter.get("/admin/overview/stream", requireAdmin, requireAdminModule, asyncHandler(adminConsoleController.overviewStream));
apiRouter.get("/admin/overview/anomalies", requireAdmin, requireAdminModule, asyncHandler(adminConsoleController.overviewAnomalies));
apiRouter.get("/admin/overview/work", requireAdmin, requireAdminModule, asyncHandler(adminConsoleController.overviewWork));
apiRouter.get("/admin/overview/incidents", requireAdmin, requireAdminModule, asyncHandler(adminConsoleController.listIncidents));
apiRouter.post("/admin/overview/incidents", requireAdmin, requireAdminModule, asyncHandler(adminConsoleController.createIncident));
apiRouter.get("/admin/card-payments", requireAdmin, requireAdminModule, asyncHandler(adminConsoleController.listCardPayments));
apiRouter.get("/admin/disputes", requireAdmin, requireAdminModule, asyncHandler(adminConsoleController.listDisputes));
apiRouter.get("/admin/refunds", requireAdmin, requireAdminModule, asyncHandler(adminConsoleController.listRefunds));
apiRouter.get("/admin/segments", requireAdmin, requireAdminModule, asyncHandler(adminConsoleController.listSegments));
apiRouter.post("/admin/segments", requireAdmin, requireAdminModule, asyncHandler(adminConsoleController.createSegment));
apiRouter.get("/admin/bank-statements", requireAdmin, requireAdminModule, asyncHandler(adminConsoleController.listStatementLines));
apiRouter.get("/admin/payout-batches", requireAdmin, requireAdminModule, asyncHandler(adminConsoleController.listPayoutBatches));
apiRouter.get("/admin/swaps", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.listSwaps));
apiRouter.get("/admin/ledger", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.listLedger));
apiRouter.get("/admin/beneficiaries", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.listBeneficiaries));
apiRouter.get("/admin/virtual-accounts", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.listVirtualAccounts));
apiRouter.get("/admin/bill-services", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.listBillServices));
apiRouter.get("/admin/bill-products", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.listBillProducts));
apiRouter.get("/admin/bill-payments", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.listBillPayments));
apiRouter.get("/admin/bill-payments/:id", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.getBillPayment));
apiRouter.get("/admin/crypto/orders", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.listCryptoOrders));
apiRouter.get("/admin/crypto/orders/:id", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.getCryptoOrder));
apiRouter.get("/admin/crypto/addresses", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.listCryptoAddresses));
apiRouter.get("/admin/crypto/wallets", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.listCryptoWallets));
apiRouter.get("/admin/crypto/assets", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.listCryptoAssets));
apiRouter.put("/admin/crypto/assets/:code", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.upsertCryptoAsset));
apiRouter.get("/admin/esims", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.listEsims));
apiRouter.get("/admin/esim-orders", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.listEsimOrders));
apiRouter.get("/admin/esim/catalogue", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.esimCatalogue));
apiRouter.get("/admin/referrals", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.listReferrals));
apiRouter.get("/admin/webhooks", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.listWebhooks));
apiRouter.get("/admin/staff", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.listStaff));
apiRouter.post("/admin/staff", requireAdmin, requireAdminModule, requireStaffManager, asyncHandler(adminOpsController.createStaff));
apiRouter.patch("/admin/staff/:id", requireAdmin, requireAdminModule, requireStaffManager, asyncHandler(adminOpsController.patchStaff));
apiRouter.post("/admin/staff/:id/offboard", requireAdmin, requireAdminModule, requireStaffManager, asyncHandler(adminOpsController.offboardStaff));
apiRouter.get("/admin/closures", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.listClosures));
apiRouter.patch("/admin/closures/:id", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.updateClosure));
apiRouter.get("/admin/devices", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.listDevices));
apiRouter.post("/admin/devices/:id/revoke", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.revokeDevice));
apiRouter.get("/admin/platform-config", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.listPlatformConfig));
apiRouter.put("/admin/platform-config", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.upsertPlatformConfig));
apiRouter.get("/admin/audit", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.listAudit));
apiRouter.get("/admin/support/stats", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.supportStats));
apiRouter.get("/admin/revenue", requireAdmin, requireAdminModule, asyncHandler(adminOpsController.revenueSummary));

apiRouter.get("/admin/compliance/aml/rules", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.getAmlRules));
apiRouter.put("/admin/compliance/aml/rules", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.putAmlRules));
apiRouter.get("/admin/compliance/aml/alerts", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.listAmlAlerts));
apiRouter.post("/admin/compliance/aml/alerts/:id/clear", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.clearAmlAlert));
apiRouter.post("/admin/compliance/aml/alerts/:id/escalate", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.escalateAmlAlert));
apiRouter.get("/admin/compliance/sanctions/lists", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.getSanctionLists));
apiRouter.put("/admin/compliance/sanctions/lists", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.putSanctionLists));
apiRouter.get("/admin/compliance/sanctions/hits", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.listSanctionHits));
apiRouter.post("/admin/compliance/sanctions/hits/:id/clear", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.clearSanctionHit));
apiRouter.post("/admin/compliance/sanctions/hits/:id/confirm", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.confirmSanctionHit));
apiRouter.get("/admin/compliance/cases", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.listCases));
apiRouter.get("/admin/compliance/cases/:id", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.getCase));
apiRouter.post("/admin/compliance/cases/:id/advance", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.advanceCase));
apiRouter.get("/admin/compliance/reports", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.listRegReports));
apiRouter.post("/admin/compliance/reports/:id/submit", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.submitRegReport));
apiRouter.get("/admin/compliance/dsr", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.listDsr));
apiRouter.post("/admin/compliance/dsr/:id/fulfil", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.fulfilDsr));
apiRouter.post("/admin/compliance/dsr/:id/refuse", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.refuseDsr));

apiRouter.get("/admin/card-programs", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.listCardPrograms));
apiRouter.post("/admin/card-programs", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.createCardProgram));
apiRouter.put("/admin/card-programs/:id", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.updateCardProgram));
apiRouter.get("/admin/card-authorisations", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.listCardAuthorisations));
apiRouter.post("/admin/card-authorisations/:id/reverse", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.reverseCardAuthorisation));
apiRouter.get("/admin/cards/bin-rules", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.getBinRules));
apiRouter.put("/admin/cards/bin-rules", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.putBinRules));
apiRouter.get("/admin/cards/limit-tiers", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.getLimitTiers));
apiRouter.put("/admin/cards/limit-tiers", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.putLimitTiers));
apiRouter.get("/admin/cards/mcc-rules", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.getMccRules));
apiRouter.put("/admin/cards/mcc-rules", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.putMccRules));

apiRouter.get("/admin/crypto/networks", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.listCryptoNetworks));
apiRouter.put("/admin/crypto/networks", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.putCryptoNetworks));
apiRouter.put("/admin/crypto/networks/:id", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.updateCryptoNetwork));
apiRouter.get("/admin/crypto/exposures", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.listCryptoExposures));
apiRouter.put("/admin/crypto/exposures", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.putCryptoExposures));
apiRouter.post("/admin/crypto/exposures/:asset/halt", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.haltCryptoExposure));

apiRouter.get("/admin/engagement/campaigns", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.listCampaigns));
apiRouter.post("/admin/engagement/campaigns", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.createCampaign));
apiRouter.put("/admin/engagement/campaigns/:id", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.updateCampaign));
apiRouter.post("/admin/engagement/campaigns/:id/launch", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.launchCampaign));
apiRouter.post("/admin/engagement/campaigns/:id/pause", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.pauseCampaign));
apiRouter.post("/admin/engagement/campaigns/:id/end", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.endCampaign));

apiRouter.get("/admin/analytics/metrics/:key", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.analyticsMetric));
apiRouter.get("/admin/analytics/cohorts", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.analyticsCohorts));
apiRouter.get("/admin/analytics/funnels", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.analyticsFunnels));
apiRouter.get("/admin/analytics/reports", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.listAnalyticsReports));
apiRouter.post("/admin/analytics/reports", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.createAnalyticsReport));
apiRouter.get("/admin/analytics/anomalies", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.analyticsAnomalies));
apiRouter.put("/admin/analytics/anomalies/subs", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.putAnomalySubs));
apiRouter.get("/admin/analytics/exports", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.analyticsExports));
apiRouter.post("/admin/analytics/exports", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.recordAnalyticsExport));
apiRouter.get("/admin/analytics/pipelines", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.analyticsPipelines));

apiRouter.get("/admin/finance/day-close", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.dayClose));
apiRouter.put("/admin/finance/day-close", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.putDayCloseOverrides));
apiRouter.get("/admin/finance/invoices", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.listInvoices));
apiRouter.put("/admin/finance/invoices", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.putInvoices));
apiRouter.get("/admin/finance/treasury", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.treasury));

apiRouter.get("/admin/engagement/referral-config", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.referralConfig));
apiRouter.put("/admin/engagement/referral-config", requireAdmin, requireAdminModule, asyncHandler(adminModulesController.putReferralConfig));
apiRouter.get(
  "/admin/float",
  requireAdmin,
  asyncHandler(async (_req, res) => ok(res, await floatJobsService.reconcile())),
);

apiRouter.get("/deposits", requireAuth, asyncHandler(depositsController.list));
apiRouter.post("/deposits/bank", requireAuth, asyncHandler(depositsController.createBank));
apiRouter.post("/deposits/busha/ngn", requireAuth, asyncHandler(depositsController.initiateBushaNgn));
apiRouter.post("/deposits/busha/ngn/confirm", requireAuth, asyncHandler(depositsController.confirmBushaNgn));
apiRouter.post("/deposits/card/initiate", requireAuth, asyncHandler(depositsController.initiateCard));
apiRouter.get("/deposits/card/verify", requireAuth, asyncHandler(depositsController.verifyCard));
apiRouter.get("/deposits/card/inline-checkout", asyncHandler(depositsController.inlineCheckout));
apiRouter.get("/deposits/card/return", asyncHandler(depositsController.cardReturn));
apiRouter.post("/admin/deposits/:id/confirm", requireAdmin, requireAdminModule, asyncHandler(depositsController.confirm));
apiRouter.get(
  "/admin/float/recon",
  requireAdmin,
  asyncHandler(async (_req, res) => ok(res, await floatJobsService.reconcile())),
);
apiRouter.post(
  "/admin/float/sweep",
  requireAdmin,
  asyncHandler(async (_req, res) => ok(res, await floatJobsService.sweepCustomerBalances())),
);
apiRouter.post(
  "/admin/float/run",
  requireAdmin,
  asyncHandler(async (_req, res) => ok(res, await floatJobsService.runDailyJobs())),
);

apiRouter.get("/banks", requireAuth, asyncHandler(transfersController.banks));
apiRouter.get("/users/lookup", requireAuth, asyncHandler(transfersController.lookup));
apiRouter.get("/beneficiaries", requireAuth, asyncHandler(transfersController.listBeneficiaries));
apiRouter.post("/beneficiaries", requireAuth, asyncHandler(transfersController.createBeneficiary));
apiRouter.delete("/beneficiaries/:id", requireAuth, asyncHandler(transfersController.deleteBeneficiary));
apiRouter.post("/transfers/resolve", requireAuth, asyncHandler(transfersController.resolve));
apiRouter.post("/transfers/fulus", requireAuth, asyncHandler(transfersController.fulus));
apiRouter.post("/transfers/bank/quote", requireAuth, asyncHandler(transfersController.bankQuote));
apiRouter.post("/transfers/bank", requireAuth, asyncHandler(transfersController.bank));

apiRouter.get("/kyc/checks", requireAuth, asyncHandler(kycController.list));
apiRouter.post("/kyc/bvn", requireAuth, asyncHandler(kycController.verifyBvn));
apiRouter.post("/kyc/nin", requireAuth, asyncHandler(kycController.verifyNin));
apiRouter.post("/kyc/address", requireAuth, asyncHandler(kycController.verifyAddress));
apiRouter.post("/kyc/face", requireAuth, asyncHandler(kycController.verifyFace));

apiRouter.get("/cards", requireAuth, asyncHandler(cardsController.list));
apiRouter.post("/cards", requireAuth, asyncHandler(cardsController.create));
apiRouter.get("/cards/:id", requireAuth, asyncHandler(cardsController.get));
apiRouter.post("/cards/:id/reveal", requireAuth, asyncHandler(cardsController.reveal));
apiRouter.post("/cards/:id/fund", requireAuth, asyncHandler(cardsController.fund));
apiRouter.post("/cards/:id/withdraw", requireAuth, asyncHandler(cardsController.withdraw));
apiRouter.post("/cards/:id/freeze", requireAuth, asyncHandler(cardsController.freeze));
apiRouter.post("/cards/:id/unfreeze", requireAuth, asyncHandler(cardsController.unfreeze));
apiRouter.patch("/cards/:id", requireAuth, asyncHandler(cardsController.rename));
apiRouter.post("/cards/:id/pin", requireAuth, asyncHandler(cardsController.setPin));
apiRouter.post("/cards/:id/limits", requireAuth, asyncHandler(cardsController.setLimits));
apiRouter.post("/cards/:id/terminate", requireAuth, asyncHandler(cardsController.terminate));
apiRouter.get("/cards/:id/statements", requireAuth, asyncHandler(cardsController.statements));

apiRouter.get("/crypto/coins", requireAuth, asyncHandler(cryptoController.coins));
apiRouter.get("/crypto/kyc-gate", requireAuth, asyncHandler(cryptoController.kycGate));
apiRouter.get("/crypto/balances", requireAuth, asyncHandler(cryptoController.balances));
apiRouter.get("/crypto/rates", requireAuth, asyncHandler(cryptoController.rates));
apiRouter.post("/crypto/quotes", requireAuth, asyncHandler(cryptoController.quote));
apiRouter.get("/crypto/orders", requireAuth, asyncHandler(cryptoController.listOrders));
apiRouter.post("/crypto/orders", requireAuth, asyncHandler(cryptoController.createOrder));
apiRouter.get("/crypto/orders/:id", requireAuth, asyncHandler(cryptoController.getOrder));
apiRouter.post("/crypto/orders/:id/mark-paid", requireAuth, asyncHandler(cryptoController.markPaid));
apiRouter.get("/crypto/addresses", requireAuth, asyncHandler(cryptoController.addresses));
apiRouter.post("/crypto/addresses", requireAuth, asyncHandler(cryptoController.receiveAddress));
apiRouter.post("/crypto/send", requireAuth, asyncHandler(cryptoController.send));
apiRouter.post("/crypto/simulate-receive", requireAuth, asyncHandler(cryptoController.simulateReceive));

apiRouter.get("/bills/catalog", requireAuth, asyncHandler(billsController.catalog));
apiRouter.get("/bills/catalog/:id", requireAuth, asyncHandler(billsController.getService));
apiRouter.get("/bills", requireAuth, asyncHandler(billsController.list));
apiRouter.post("/bills/verify-meter", requireAuth, asyncHandler(billsController.verifyMeter));
apiRouter.post("/bills/pay", requireAuth, asyncHandler(billsController.pay));

apiRouter.get("/esim/catalogue", requireAuth, asyncHandler(esimController.catalogue));
apiRouter.get("/esims", requireAuth, asyncHandler(esimController.list));
apiRouter.post("/esims/purchase", requireAuth, asyncHandler(esimController.purchase));
apiRouter.get("/esims/:id", requireAuth, asyncHandler(esimController.get));
apiRouter.get("/esims/:id/usage", requireAuth, asyncHandler(esimController.usage));
apiRouter.post("/esims/:id/sync", requireAuth, asyncHandler(esimController.sync));
apiRouter.patch("/esims/:id", requireAuth, asyncHandler(esimController.patch));
apiRouter.post("/esims/:id/topup", requireAuth, asyncHandler(esimController.topup));

apiRouter.post("/webhooks/esim-go", asyncHandler(webhooksController.esimGo));
apiRouter.post("/webhooks/busha", asyncHandler(webhooksController.busha));
apiRouter.post("/webhooks/pagocards", asyncHandler(webhooksController.pagocards));
apiRouter.post("/webhooks/strowallet", asyncHandler(webhooksController.strowallet));
apiRouter.post("/webhooks/flutterwave", asyncHandler(webhooksController.flutterwave));
