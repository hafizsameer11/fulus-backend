import type { Request, Response } from "express";
import type { WalletCurrency } from "@prisma/client";
import { z } from "zod";
import { ok } from "../../../lib/http.js";
import { AppError, UnauthorizedError } from "../../../lib/errors.js";
import { simulateProviders } from "../../../lib/simulate.js";
import { walletService } from "../services/wallet.service.js";

const demoCreditSchema = z.object({
  currency: z.enum(["NGN", "USD", "SAR"]).default("NGN"),
  amount: z.number().positive().max(500_000).default(50_000),
});

export class WalletController {
  list = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    const wallets = await walletService.listWallets(req.user.id);
    return ok(res, wallets);
  };

  getOne = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    const currency = String(req.params.currency).toUpperCase() as WalletCurrency;
    const wallet = await walletService.getWallet(req.user.id, currency);
    return ok(res, wallet);
  };

  transactions = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    const txs = await walletService.listTransactions(req.user.id);
    return ok(res, txs);
  };

  getTransaction = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await walletService.getTransaction(req.user.id, String(req.params.id)));
  };

  /** Simulation-only faucet so bill/card flows can be tested without a real VA credit. */
  demoCredit = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    if (!simulateProviders()) {
      throw new AppError("Demo credit is disabled when live providers are on", 403, "DEMO_DISABLED");
    }
    const input = demoCreditSchema.parse(req.body ?? {});
    const tx = await walletService.credit({
      userId: req.user.id,
      currency: input.currency,
      amount: input.amount,
      type: "ADJUSTMENT",
      description: `Demo credit ${input.currency}`,
      provider: "demo",
    });
    return ok(res, { transaction: tx, credited: input.amount, currency: input.currency });
  };
}

export const walletController = new WalletController();
