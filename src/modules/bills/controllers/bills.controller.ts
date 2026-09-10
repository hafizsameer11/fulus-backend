import type { Request, Response } from "express";
import { created, ok } from "../../../lib/http.js";
import { UnauthorizedError } from "../../../lib/errors.js";
import { billsService, payBillSchema, verifyMeterSchema } from "../services/bills.service.js";

export class BillsController {
  list = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await billsService.list(req.user.id));
  };

  catalog = async (req: Request, res: Response) => {
    const category = req.query.category ? String(req.query.category) : undefined;
    return ok(res, await billsService.catalog(category));
  };

  getService = async (req: Request, res: Response) => {
    return ok(res, await billsService.getService(String(req.params.id)));
  };

  verifyMeter = async (req: Request, res: Response) => {
    const input = verifyMeterSchema.parse(req.body);
    return ok(res, await billsService.verifyMeter(input));
  };

  pay = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    const input = payBillSchema.parse(req.body);
    return created(res, await billsService.pay(req.user.id, input));
  };
}

export const billsController = new BillsController();
