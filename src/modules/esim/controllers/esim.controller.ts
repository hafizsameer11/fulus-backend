import type { Request, Response } from "express";
import { created, ok } from "../../../lib/http.js";
import { UnauthorizedError } from "../../../lib/errors.js";
import { esimService, patchEsimSchema, purchaseSchema, topupSchema } from "../services/esim.service.js";

export class EsimController {
  catalogue = async (req: Request, res: Response) => {
    const query = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v)]));
    return ok(res, await esimService.catalogue(query));
  };

  list = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await esimService.list(req.user.id));
  };

  get = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await esimService.get(req.user.id, String(req.params.id)));
  };

  purchase = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    const input = purchaseSchema.parse(req.body);
    return created(res, await esimService.purchase(req.user.id, input));
  };

  topup = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return created(res, await esimService.topup(req.user.id, String(req.params.id), topupSchema.parse(req.body)));
  };

  patch = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await esimService.patch(req.user.id, String(req.params.id), patchEsimSchema.parse(req.body)));
  };

  usage = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await esimService.usage(req.user.id, String(req.params.id)));
  };

  sync = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await esimService.sync(req.user.id, String(req.params.id)));
  };
}

export const esimController = new EsimController();
