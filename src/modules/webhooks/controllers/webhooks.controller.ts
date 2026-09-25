import type { Request, Response } from "express";
import { ok } from "../../../lib/http.js";
import { webhooksService } from "../services/webhooks.service.js";

export class WebhooksController {
  esimGo = async (req: Request, res: Response) => {
    const rawBody =
      typeof req.rawBody === "string"
        ? req.rawBody
        : typeof req.body === "string"
          ? req.body
          : JSON.stringify(req.body ?? {});
    const signature =
      req.header("X-Signature-SHA256") ??
      req.header("x-signature-sha256") ??
      undefined;
    const payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
    const event = await webhooksService.handleEsimGo(rawBody, signature, payload);
    return ok(res, { id: event.id, processed: true });
  };

  busha = async (req: Request, res: Response) => {
    const event = await webhooksService.handleBusha(req.body);
    return ok(res, { id: event.id, processed: true });
  };

  pagocards = async (req: Request, res: Response) => {
    const event = await webhooksService.handlePagocards(req.body);
    return ok(res, { id: event.id, processed: true });
  };

  strowallet = async (req: Request, res: Response) => {
    const event = await webhooksService.handleStrowallet(req.body);
    return ok(res, { id: event.id, processed: true });
  };
}

export const webhooksController = new WebhooksController();
