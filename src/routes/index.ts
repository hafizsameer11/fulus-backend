import { Router } from "express";
import { asyncHandler } from "../middleware/error-handler.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
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
import { simulateProviders } from "../lib/simulate.js";

export const apiRouter = Router();

apiRouter.get("/health", (_req, res) => {
  res.json({
    success: true,
    data: {
      service: "fulus-api",
      status: "ok",
      simulateProviders: simulateProviders(),
      providers: ["pagocards", "busha", "prembly", "strowallet", "esim-go"],
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
apiRouter.post("/me/change-password", requireAuth, asyncHandler(usersController.changePassword));
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

apiRouter.get("/admin/fx/rates", requireAdmin, asyncHandler(fxController.adminList));
apiRouter.put("/admin/fx/rates", requireAdmin, asyncHandler(fxController.adminUpsert));

apiRouter.get("/deposits", requireAuth, asyncHandler(depositsController.list));
apiRouter.post("/deposits/bank", requireAuth, asyncHandler(depositsController.createBank));
apiRouter.post("/admin/deposits/:id/confirm", requireAdmin, asyncHandler(depositsController.confirm));

apiRouter.get("/banks", requireAuth, asyncHandler(transfersController.banks));
apiRouter.get("/users/lookup", requireAuth, asyncHandler(transfersController.lookup));
apiRouter.get("/beneficiaries", requireAuth, asyncHandler(transfersController.listBeneficiaries));
apiRouter.post("/beneficiaries", requireAuth, asyncHandler(transfersController.createBeneficiary));
apiRouter.delete("/beneficiaries/:id", requireAuth, asyncHandler(transfersController.deleteBeneficiary));
apiRouter.post("/transfers/resolve", requireAuth, asyncHandler(transfersController.resolve));
apiRouter.post("/transfers/fulus", requireAuth, asyncHandler(transfersController.fulus));
apiRouter.post("/transfers/bank", requireAuth, asyncHandler(transfersController.bank));

apiRouter.get("/kyc/checks", requireAuth, asyncHandler(kycController.list));
apiRouter.post("/kyc/bvn", requireAuth, asyncHandler(kycController.verifyBvn));
apiRouter.post("/kyc/nin", requireAuth, asyncHandler(kycController.verifyNin));
apiRouter.post("/kyc/address", requireAuth, asyncHandler(kycController.verifyAddress));
apiRouter.post("/kyc/face", requireAuth, asyncHandler(kycController.verifyFace));

apiRouter.get("/cards", requireAuth, asyncHandler(cardsController.list));
apiRouter.post("/cards", requireAuth, asyncHandler(cardsController.create));
apiRouter.get("/cards/:id", requireAuth, asyncHandler(cardsController.get));
apiRouter.post("/cards/:id/fund", requireAuth, asyncHandler(cardsController.fund));
apiRouter.post("/cards/:id/freeze", requireAuth, asyncHandler(cardsController.freeze));
apiRouter.post("/cards/:id/unfreeze", requireAuth, asyncHandler(cardsController.unfreeze));
apiRouter.patch("/cards/:id", requireAuth, asyncHandler(cardsController.rename));
apiRouter.post("/cards/:id/pin", requireAuth, asyncHandler(cardsController.setPin));
apiRouter.post("/cards/:id/limits", requireAuth, asyncHandler(cardsController.setLimits));
apiRouter.post("/cards/:id/terminate", requireAuth, asyncHandler(cardsController.terminate));
apiRouter.get("/cards/:id/statements", requireAuth, asyncHandler(cardsController.statements));

apiRouter.get("/crypto/balances", requireAuth, asyncHandler(cryptoController.balances));
apiRouter.get("/crypto/rates", requireAuth, asyncHandler(cryptoController.rates));
apiRouter.post("/crypto/quotes", requireAuth, asyncHandler(cryptoController.quote));
apiRouter.get("/crypto/orders", requireAuth, asyncHandler(cryptoController.listOrders));
apiRouter.post("/crypto/orders", requireAuth, asyncHandler(cryptoController.createOrder));
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
apiRouter.patch("/esims/:id", requireAuth, asyncHandler(esimController.patch));
apiRouter.post("/esims/:id/topup", requireAuth, asyncHandler(esimController.topup));

apiRouter.post("/webhooks/esim-go", asyncHandler(webhooksController.esimGo));
apiRouter.post("/webhooks/busha", asyncHandler(webhooksController.busha));
apiRouter.post("/webhooks/pagocards", asyncHandler(webhooksController.pagocards));
apiRouter.post("/webhooks/strowallet", asyncHandler(webhooksController.strowallet));
