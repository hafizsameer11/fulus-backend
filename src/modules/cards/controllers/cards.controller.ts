import type { Request, Response } from "express";
import { created, ok } from "../../../lib/http.js";
import { UnauthorizedError } from "../../../lib/errors.js";
import {
  cardsService,
  createCardSchema,
  fundCardSchema,
  limitsCardSchema,
  pinCardSchema,
  renameCardSchema,
  withdrawCardSchema,
} from "../services/cards.service.js";

export class CardsController {
  list = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await cardsService.list(req.user.id));
  };

  get = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await cardsService.get(req.user.id, String(req.params.id)));
  };

  reveal = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await cardsService.reveal(req.user.id, String(req.params.id)));
  };

  create = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    const input = createCardSchema.parse(req.body);
    return created(res, await cardsService.create(req.user.id, input));
  };

  fund = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    const input = fundCardSchema.parse(req.body);
    return ok(res, await cardsService.fund(req.user.id, String(req.params.id), input));
  };

  withdraw = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    const input = withdrawCardSchema.parse(req.body);
    return ok(res, await cardsService.withdraw(req.user.id, String(req.params.id), input));
  };

  freeze = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await cardsService.freeze(req.user.id, String(req.params.id)));
  };

  unfreeze = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await cardsService.unfreeze(req.user.id, String(req.params.id)));
  };

  rename = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await cardsService.rename(req.user.id, String(req.params.id), renameCardSchema.parse(req.body)));
  };

  setPin = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await cardsService.setPin(req.user.id, String(req.params.id), pinCardSchema.parse(req.body)));
  };

  setLimits = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await cardsService.setLimits(req.user.id, String(req.params.id), limitsCardSchema.parse(req.body)));
  };

  terminate = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await cardsService.terminate(req.user.id, String(req.params.id)));
  };

  statements = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await cardsService.statements(req.user.id, String(req.params.id)));
  };
}

export const cardsController = new CardsController();
