import type { Request, Response } from "express";
import { created, ok } from "../../../lib/http.js";
import { UnauthorizedError } from "../../../lib/errors.js";
import { prisma } from "../../../lib/prisma.js";
import {
  createOrderSchema,
  cryptoService,
  quoteSchema,
  receiveSchema,
  sendSchema,
} from "../services/crypto.service.js";
import { z } from "zod";

export class CryptoController {
  coins = async (_req: Request, res: Response) => ok(res, await cryptoService.coins());

  kycGate = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await cryptoService.kycGate(req.user.id));
  };

  balances = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await cryptoService.balances(req.user.id));
  };

  rates = async (_req: Request, res: Response) => ok(res, await cryptoService.rates());

  quote = async (req: Request, res: Response) => {
    const input = quoteSchema.parse(req.body);
    let customerId: string | undefined;
    if (req.user) {
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { bushaCustomerId: true },
      });
      customerId = user?.bushaCustomerId ?? undefined;
    }
    return ok(res, await cryptoService.createQuote(input, customerId, req.user?.id));
  };

  listOrders = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await cryptoService.listOrders(req.user.id));
  };

  createOrder = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    const input = createOrderSchema.parse(req.body);
    return created(res, await cryptoService.createOrder(req.user.id, input));
  };

  addresses = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await cryptoService.listAddresses(req.user.id));
  };

  receiveAddress = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    const input = receiveSchema.parse(req.body);
    return ok(res, await cryptoService.getOrCreateAddress(req.user.id, input));
  };

  send = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    const input = sendSchema.parse(req.body);
    return created(res, await cryptoService.send(req.user.id, input));
  };

  simulateReceive = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    const input = receiveSchema.extend({ amount: z.number().positive().optional() }).parse(req.body);
    return created(res, await cryptoService.simulateReceive(req.user.id, input));
  };
}

export const cryptoController = new CryptoController();
