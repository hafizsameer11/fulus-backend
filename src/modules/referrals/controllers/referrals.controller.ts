import type { Request, Response } from "express";
import { ok } from "../../../lib/http.js";
import { UnauthorizedError } from "../../../lib/errors.js";
import { referralsService } from "../services/referrals.service.js";

export class ReferralsController {
  me = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await referralsService.getMyReferrals(req.user.id));
  };
}

export const referralsController = new ReferralsController();
