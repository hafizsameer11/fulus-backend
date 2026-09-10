import type { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { esimGoClient } from "../../../providers/esim-go/client.js";
import { AppError } from "../../../lib/errors.js";

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export class WebhooksService {
  async ingest(provider: string, payload: unknown, headers?: Record<string, unknown>, eventType?: string) {
    return prisma.webhookEvent.create({
      data: {
        provider,
        eventType,
        payload: asJson(payload),
        headers: headers ? asJson(headers) : undefined,
      },
    });
  }

  async handleEsimGo(rawBody: string, signature: string | undefined, payload: unknown) {
    if (!esimGoClient.verifyWebhookSignature(rawBody, signature)) {
      throw new AppError("Invalid eSIM Go webhook signature", 401, "INVALID_SIGNATURE");
    }

    const event = await this.ingest("esim-go", payload, { signature }, this.eventType(payload));
    // Extend with usage / lifecycle updates as webhook schemas are finalized.
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { processed: true },
    });
    return event;
  }

  async handleBusha(payload: unknown) {
    const event = await this.ingest("busha", payload, undefined, this.eventType(payload));
    await prisma.webhookEvent.update({ where: { id: event.id }, data: { processed: true } });
    return event;
  }

  async handlePagocards(payload: unknown) {
    const event = await this.ingest("pagocards", payload, undefined, this.eventType(payload));
    await prisma.webhookEvent.update({ where: { id: event.id }, data: { processed: true } });
    return event;
  }

  async handleStrowallet(payload: unknown) {
    const event = await this.ingest("strowallet", payload, undefined, this.eventType(payload));
    await prisma.webhookEvent.update({ where: { id: event.id }, data: { processed: true } });
    return event;
  }

  private eventType(payload: unknown) {
    if (!payload || typeof payload !== "object") return undefined;
    const p = payload as Record<string, unknown>;
    if (typeof p.event === "string") return p.event;
    if (typeof p.type === "string") return p.type;
    if (typeof p.eventType === "string") return p.eventType;
    return undefined;
  }
}

export const webhooksService = new WebhooksService();
