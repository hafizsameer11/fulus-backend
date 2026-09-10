import type { Request, Response } from "express";
import { created, ok } from "../../../lib/http.js";
import { UnauthorizedError } from "../../../lib/errors.js";
import { addressSchema, bvnSchema, faceSchema, kycService, ninSchema } from "../services/kyc.service.js";

export class KycController {
  list = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await kycService.listChecks(req.user.id));
  };

  verifyBvn = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return created(res, await kycService.verifyBvn(req.user.id, bvnSchema.parse(req.body)));
  };

  verifyNin = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return created(res, await kycService.verifyNin(req.user.id, ninSchema.parse(req.body)));
  };

  verifyAddress = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return created(res, await kycService.verifyAddress(req.user.id, addressSchema.parse(req.body)));
  };

  verifyFace = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return created(res, await kycService.verifyFace(req.user.id, faceSchema.parse(req.body)));
  };
}

export const kycController = new KycController();
