import type { Request, Response } from "express";
import { created, ok } from "../../../lib/http.js";
import { UnauthorizedError } from "../../../lib/errors.js";
import {
  bankTransferSchema,
  beneficiarySchema,
  fulusTransferSchema,
  resolveSchema,
  transfersService,
} from "../services/transfers.service.js";

export class TransfersController {
  banks = async (_req: Request, res: Response) => ok(res, transfersService.listBanks());

  lookup = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await transfersService.lookupUser(String(req.query.q ?? "")));
  };

  listBeneficiaries = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await transfersService.listBeneficiaries(req.user.id));
  };

  createBeneficiary = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return created(res, await transfersService.createBeneficiary(req.user.id, beneficiarySchema.parse(req.body)));
  };

  deleteBeneficiary = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await transfersService.deleteBeneficiary(req.user.id, String(req.params.id)));
  };

  resolve = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await transfersService.resolveAccount(resolveSchema.parse(req.body)));
  };

  fulus = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    const input = fulusTransferSchema.parse({
      ...req.body,
      idempotencyKey: req.header("Idempotency-Key") ?? req.body.idempotencyKey,
    });
    return created(res, await transfersService.transferFulus(req.user.id, input));
  };

  bank = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    const input = bankTransferSchema.parse({
      ...req.body,
      idempotencyKey: req.header("Idempotency-Key") ?? req.body.idempotencyKey,
    });
    return created(res, await transfersService.transferBank(req.user.id, input));
  };
}

export const transfersController = new TransfersController();
