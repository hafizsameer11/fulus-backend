import type { Request, Response } from "express";
import { created, ok } from "../../../lib/http.js";
import { UnauthorizedError } from "../../../lib/errors.js";
import { fxService, quoteSchema, swapSchema, upsertFxSchema } from "../services/fx.service.js";

export class FxController {
  listRates = async (_req: Request, res: Response) => ok(res, await fxService.listRates());

  quote = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    const input = quoteSchema.parse(req.body);
    return ok(res, await fxService.quote(req.user.id, input));
  };

  swap = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    const input = swapSchema.parse({
      ...req.body,
      idempotencyKey: req.header("Idempotency-Key") ?? req.body.idempotencyKey,
    });
    return created(res, await fxService.executeSwap(req.user.id, input));
  };

  adminUpsert = async (req: Request, res: Response) => {
    const input = upsertFxSchema.parse(req.body);
    return ok(res, await fxService.upsertRate(input, "admin"));
  };

  adminList = async (_req: Request, res: Response) => ok(res, await fxService.listRates());
}

export const fxController = new FxController();
