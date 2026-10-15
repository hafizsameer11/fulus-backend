import type { Request, Response } from "express";
import { z } from "zod";
import { ok } from "../../../lib/http.js";
import { UnauthorizedError } from "../../../lib/errors.js";
import { referralsService } from "../services/referrals.service.js";

const validateSchema = z.object({
  code: z.string().min(1).max(32),
});

export class ReferralsController {
  me = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await referralsService.getMyReferrals(req.user.id));
  };

  validate = async (req: Request, res: Response) => {
    const { code } = validateSchema.parse({
      code: String(req.query.code ?? req.body?.code ?? ""),
    });
    return ok(res, await referralsService.validateReferralCode(code));
  };
}

export const referralsController = new ReferralsController();
