import type { Request, Response } from "express";
import { created, ok } from "../../../lib/http.js";
import { UnauthorizedError } from "../../../lib/errors.js";
import {
  createTicketSchema,
  postMessageSchema,
  supportService,
} from "../services/support.service.js";

export class SupportController {
  create = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return created(res, await supportService.createTicket(req.user.id, createTicketSchema.parse(req.body)));
  };

  list = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, { tickets: await supportService.listTickets(req.user.id) });
  };

  get = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await supportService.getTicket(req.user.id, String(req.params.id ?? "")));
  };

  message = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(
      res,
      await supportService.postMessage(req.user.id, String(req.params.id ?? ""), postMessageSchema.parse(req.body)),
    );
  };
}

export const supportController = new SupportController();
