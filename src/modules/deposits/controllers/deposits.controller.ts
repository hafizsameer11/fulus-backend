import type { Request, Response } from "express";
import { created, ok } from "../../../lib/http.js";
import { UnauthorizedError } from "../../../lib/errors.js";
import { createDepositSchema, depositsService } from "../services/deposits.service.js";
import { z } from "zod";

export class DepositsController {
  createBank = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    const input = createDepositSchema.parse(req.body ?? {});
    return created(res, await depositsService.createBankDeposit(req.user.id, input));
  };

  list = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await depositsService.list(req.user.id));
  };

  virtualAccount = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await depositsService.ensureVirtualAccount(req.user.id));
  };

  confirm = async (req: Request, res: Response) => {
    const body = z.object({ amount: z.number().positive().optional() }).parse(req.body ?? {});
    return ok(res, await depositsService.confirm(String(req.params.id), body.amount));
  };
}

export const depositsController = new DepositsController();
