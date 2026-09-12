import type { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { esimGoClient } from "../../../providers/esim-go/client.js";
import { strowalletClient } from "../../../providers/strowallet/client.js";
import { walletService } from "../../wallet/services/wallet.service.js";
import { AppError } from "../../../lib/errors.js";
import { makeReference } from "../../../lib/http.js";

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function asRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

/**
 * Strowallet webhooks (docs):
 * - Virtual account credit: sessionId + accountNumber + settledAmount/transactionAmount
 * - Bank transfer: event banktransfer.success | banktransfer.refunded (+ VerifyWebHookTranfer)
 * - Cards / USDT: event virtualcard.* | usdt.transfer.success | otp.code
 * Bill payments are synchronous API responses — no dedicated bill webhook in docs.
 */
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
    const p = asRecord(payload);
    const eventType = this.eventType(payload);
    const event = await this.ingest("strowallet", payload, undefined, eventType);

    try {
      // 1) Virtual account inbound credit (sample in webhook.md)
      if (str(p.sessionId) && str(p.accountNumber)) {
        await this.creditFromVirtualAccountWebhook(p);
      }

      // 2) Outbound bank transfer status (bank-transfer-webhook.md)
      const evt = str(p.event);
      if (evt === "banktransfer.success" || evt === "banktransfer.refunded") {
        await this.handleBankTransferWebhook(p);
      }

      // 3) Card / USDT lifecycle (webhook-for-card.md)
      if (evt?.startsWith("virtualcard.") || evt === "usdt.transfer.success" || evt === "otp.code") {
        await this.handleCardLifecycleWebhook(p);
      }

      return prisma.webhookEvent.update({
        where: { id: event.id },
        data: { processed: true, error: null },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Webhook processing failed";
      await prisma.webhookEvent.update({
        where: { id: event.id },
        data: { processed: false, error: message },
      });
      throw error;
    }
  }

  private async creditFromVirtualAccountWebhook(p: Record<string, unknown>) {
    const accountNumber = str(p.accountNumber)!;
    const sessionId = str(p.sessionId)!;
    const amount =
      num(p.settledAmount) ?? num(p.transactionAmount) ?? num(p.amount) ?? 0;
    if (amount <= 0) return;

    const existing = await prisma.deposit.findFirst({
      where: { provider: "strowallet", providerRef: sessionId },
    });
    if (existing) return;

    const va = await prisma.virtualAccount.findFirst({
      where: { accountNumber, status: "ACTIVE" },
    });
    if (!va) {
      // Keep webhook accepted; store for ops — VA may be created under another provider later
      return;
    }

    const tx = await walletService.credit({
      userId: va.userId,
      currency: va.currency,
      amount,
      type: "DEPOSIT",
      description: str(p.tranRemarks) ?? `VA credit ${accountNumber}`,
      provider: "strowallet",
      providerRef: sessionId,
      metadata: asJson({
        settlementId: p.settlementId,
        sourceAccountName: p.sourceAccountName,
        sourceBankName: p.sourceBankName,
        sourceAccountNumber: p.sourceAccountNumber,
        feeAmount: p.feeAmount,
        vatAmount: p.vatAmount,
        currency: p.currency,
        tranDateTime: p.tranDateTime,
      }),
    });

    await prisma.deposit.create({
      data: {
        userId: va.userId,
        transactionId: tx.id,
        method: "VIRTUAL_ACCOUNT",
        currency: va.currency,
        amount,
        status: "SUCCESS",
        provider: "strowallet",
        providerRef: sessionId,
        confirmedAt: new Date(),
        metadata: asJson(p),
        instructions: {
          bankName: va.bankName,
          accountName: va.accountName,
          accountNumber: va.accountNumber,
          reference: makeReference("DEP"),
        },
      },
    });
  }

  private async handleBankTransferWebhook(p: Record<string, unknown>) {
    const merchantTxRef = str(p.merchantTxRef);
    const sessionId = str(p.sessionId);
    const evt = str(p.event);

    // Prefer official verify endpoint when we have a merchant ref
    if (merchantTxRef) {
      try {
        await strowalletClient.verifyWebhookTransfer(merchantTxRef);
      } catch {
        // Non-fatal: still record status update on matching transfer if present
      }
    }

    const providerRef = merchantTxRef ?? sessionId;
    if (!providerRef) return;

    const transfer = await prisma.bankTransfer.findFirst({
      where: { providerRef },
    });
    if (!transfer) return;

    if (evt === "banktransfer.success" && transfer.status !== "SUCCESS") {
      await prisma.bankTransfer.update({
        where: { id: transfer.id },
        data: { status: "SUCCESS", providerRef },
      });
      await prisma.transaction.update({
        where: { id: transfer.transactionId },
        data: { status: "SUCCESS", providerRef },
      });
    }

    if (evt === "banktransfer.refunded" && transfer.status !== "FAILED") {
      const prior = transfer.status;
      await prisma.bankTransfer.update({
        where: { id: transfer.id },
        data: {
          status: "FAILED",
          failureReason: str(p.narration) ?? "Refunded by provider",
          providerRef,
        },
      });
      await prisma.transaction.update({
        where: { id: transfer.transactionId },
        data: { status: "FAILED", providerRef },
      });
      if (prior === "SUCCESS" || prior === "PENDING" || prior === "PROCESSING") {
        await walletService.credit({
          userId: transfer.userId,
          currency: transfer.currency,
          amount: transfer.amount,
          type: "ADJUSTMENT",
          description: `Bank transfer refund ${providerRef}`,
          provider: "strowallet",
          providerRef: `refund:${providerRef}`,
        });
      }
    }
  }

  private async handleCardLifecycleWebhook(p: Record<string, unknown>) {
    const cardId = str(p.cardId);
    const evt = str(p.event) ?? "";
    if (!cardId) return;

    const card = await prisma.card.findFirst({
      where: {
        OR: [{ providerCardId: cardId }, { id: cardId }],
      },
    });
    if (!card) return;

    if (evt.includes("created.complete") || evt === "virtualcard.created.complete") {
      await prisma.card.update({
        where: { id: card.id },
        data: {
          status: "ACTIVE",
          last4: str(p.lastFour) ?? card.last4,
          brand: str(p.cardBrand) ?? card.brand,
          providerPayload: asJson(p),
        },
      });
      return;
    }

    if (evt.includes("created.failed") || evt.includes("terminated")) {
      await prisma.card.update({
        where: { id: card.id },
        data: {
          status: evt.includes("terminated") ? "TERMINATED" : "FAILED",
          providerPayload: asJson(p),
        },
      });
      return;
    }

    if (evt.includes("topup.complete")) {
      const amount = num(p.amount);
      if (amount && amount > 0) {
        await prisma.card.update({
          where: { id: card.id },
          data: {
            balance: { increment: amount },
            providerPayload: asJson(p),
          },
        });
      }
      return;
    }

    if (evt.includes("withdrawal.success")) {
      const credited = num(p.credited) ?? num(p.amount);
      if (credited && credited > 0) {
        await prisma.card.update({
          where: { id: card.id },
          data: {
            balance: { decrement: credited },
            providerPayload: asJson(p),
          },
        });
      }
    }
  }

  private eventType(payload: unknown) {
    if (!payload || typeof payload !== "object") return undefined;
    const p = payload as Record<string, unknown>;
    if (typeof p.event === "string") return p.event;
    if (typeof p.type === "string") return p.type;
    if (typeof p.eventType === "string") return p.eventType;
    if (typeof p.sessionId === "string" && typeof p.accountNumber === "string") {
      return "virtual_account.credit";
    }
    return undefined;
  }
}

export const webhooksService = new WebhooksService();
