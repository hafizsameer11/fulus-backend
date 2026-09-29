import type { Request, Response } from "express";
import { ok } from "../../../lib/http.js";
import { UnauthorizedError } from "../../../lib/errors.js";
import { patchSecuritySchema, securityService } from "../services/security.service.js";

export class SecurityController {
  get = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await securityService.getSecurity(req.user.id));
  };

  patch = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await securityService.patchSecurity(req.user.id, patchSecuritySchema.parse(req.body)));
  };
}

export const securityController = new SecurityController();
