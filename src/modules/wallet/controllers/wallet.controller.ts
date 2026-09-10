import type { Request, Response } from "express";
import type { WalletCurrency } from "@prisma/client";
import { ok } from "../../../lib/http.js";
import { UnauthorizedError } from "../../../lib/errors.js";
import { walletService } from "../services/wallet.service.js";

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
}

export const walletController = new WalletController();
