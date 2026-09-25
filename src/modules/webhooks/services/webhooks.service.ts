import type { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { esimGoClient } from "../../../providers/esim-go/client.js";
import { strowalletClient } from "../../../providers/strowallet/client.js";
import { walletService } from "../../wallet/services/wallet.service.js";
import { AppError } from "../../../lib/errors.js";
import { makeReference } from "../../../lib/http.js";
import { createInboxMessage } from "../../../lib/inbox.js";
import { bushaCustomerService } from "../../busha/services/busha-customer.service.js";
import { cardsService } from "../../cards/services/cards.service.js";

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

    const p = asRecord(payload);
    const eventType =
      this.eventType(payload) ??
      str(p.alertType) ??
      str(p.AlertType) ??
      (str(p.iccid) ? "esim.usage" : undefined);
    const event = await this.ingest("esim-go", payload, { signature }, eventType);

    try {
      const { esimService } = await import("../../esim/services/esim.service.js");
      await esimService.applyWebhookUpdate(p);
      return prisma.webhookEvent.update({
        where: { id: event.id },
        data: { processed: true, error: null },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "eSIM Go webhook processing failed";
      await prisma.webhookEvent.update({
        where: { id: event.id },
        data: { processed: false, error: message },
      });
      throw error;
    }
  }

  async handleBusha(payload: unknown) {
    const p = asRecord(payload);
    const eventType = this.eventType(payload);
    const event = await this.ingest("busha", payload, undefined, eventType);
    const data = asRecord(p.data);

    try {
      if (eventType?.startsWith("customer.verification.") || eventType === "customer.updated") {
        const customerId = str(data.id);
        const status =
          str(data.status) ??
          (eventType === "customer.verification.active"
            ? "active"
            : eventType === "customer.verification.rejected"
              ? "rejected"
              : eventType === "customer.verification.in_review"
                ? "in_review"
                : eventType === "customer.verification.inactive"
                  ? "inactive"
                  : undefined);
        if (customerId && status) {
          await bushaCustomerService.syncStatusFromWebhook(
            customerId,
            status,
            str(data.rejection_reason),
          );
        }
      }

      if (eventType === "deposit.success") {
        await this.handleBushaDeposit(data);
      }

      if (
        eventType === "transfer.completed" ||
        eventType === "transfer.failed" ||
        eventType === "transfer.cancelled" ||
        eventType === "transfer.funds_converted" ||
        eventType === "transfer.funds_received" ||
        eventType === "transfer.funds_delivered"
      ) {
        await this.handleBushaTransfer(eventType, data);
      }

      return prisma.webhookEvent.update({
        where: { id: event.id },
        data: { processed: true, error: null },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Busha webhook processing failed";
      await prisma.webhookEvent.update({
        where: { id: event.id },
        data: { processed: false, error: message },
      });
      throw error;
    }
  }

  private async handleBushaDeposit(data: Record<string, unknown>) {
    const reference = str(data.reference) ?? str(data.id);
    const profileId = str(data.profile_id);
    const amount = num(data.amount) ?? 0;
    const currency = str(data.currency)?.toUpperCase();
    if (!reference || !amount || amount <= 0 || !currency) return;

    const existing = await prisma.deposit.findFirst({
      where: { provider: "busha", providerRef: reference },
    });
    if (existing) return;

    const existingTx = await prisma.transaction.findFirst({
      where: { provider: "busha", providerRef: reference, type: "CRYPTO_RECEIVE" },
    });
    if (existingTx) return;

    const user = profileId
      ? await prisma.user.findFirst({ where: { bushaCustomerId: profileId } })
      : null;
    if (!user) return;

    const fiat = ["NGN", "USD", "SAR"].includes(currency);
    const crypto = ["USDT", "BTC", "ETH"].includes(currency);

    if (!fiat && !crypto) {
      await createInboxMessage({
        userId: user.id,
        category: "crypto",
        title: "Crypto deposit received",
        body: `Busha reported a ${amount} ${currency} deposit (${reference}).`,
      });
      return;
    }

    if (crypto) {
      await prisma.wallet.upsert({
        where: { userId_currency: { userId: user.id, currency: currency as "USDT" | "BTC" | "ETH" } },
        create: { userId: user.id, currency: currency as "USDT" | "BTC" | "ETH", isVirtual: true, available: 0, pending: 0 },
        update: {},
      });
    }

    const tx = await walletService.credit({
      userId: user.id,
      currency: currency as "NGN" | "USD" | "SAR" | "USDT" | "BTC" | "ETH",
      amount,
      type: crypto ? "CRYPTO_RECEIVE" : "DEPOSIT",
      description: str(data.channel)
        ? `Busha ${String(data.channel)} deposit`
        : crypto
          ? `Received ${currency}`
          : "Busha deposit",
      provider: "busha",
      providerRef: reference,
      metadata: asJson(data),
    });

    if (fiat) {
      await prisma.deposit.create({
        data: {
          userId: user.id,
          transactionId: tx.id,
          method: "CRYPTO",
          currency: currency as "NGN" | "USD" | "SAR",
          amount,
          status: "SUCCESS",
          provider: "busha",
          providerRef: reference,
          confirmedAt: new Date(),
          metadata: asJson(data),
          instructions: { reference },
        },
      });
    }

    await createInboxMessage({
      userId: user.id,
      category: crypto ? "crypto" : "wallet",
      title: crypto ? "Crypto received" : "Deposit confirmed",
      body: `${amount} ${currency} was credited from Busha.`,
    });
  }

  private async handleBushaTransfer(eventType: string, data: Record<string, unknown>) {
    const providerRef = str(data.id) ?? str(data.reference);
    if (!providerRef) return;

    const order = await prisma.cryptoOrder.findFirst({
      where: { providerRef },
    });

    // Crypto send (withdraw) — mark debit tx SUCCESS / FAILED
    if (!order) {
      const sendTx = await prisma.transaction.findFirst({
        where: { providerRef, type: "CRYPTO_SEND" },
      });
      if (sendTx) {
        const ok =
          eventType === "transfer.completed" ||
          eventType === "transfer.funds_converted" ||
          eventType === "transfer.funds_delivered";
        const failed = eventType === "transfer.failed" || eventType === "transfer.cancelled";
        if (ok && sendTx.status !== "SUCCESS") {
          await prisma.transaction.update({
            where: { id: sendTx.id },
            data: { status: "SUCCESS", metadata: asJson({ ...asRecord(sendTx.metadata), webhook: data, eventType }) },
          });
        } else if (failed && sendTx.status === "PROCESSING") {
          await prisma.transaction.update({
            where: { id: sendTx.id },
            data: { status: "FAILED" },
          });
          await walletService.credit({
            userId: sendTx.userId,
            currency: sendTx.currency,
            amount: sendTx.amount,
            type: "ADJUSTMENT",
            description: `Refund failed crypto send ${sendTx.reference}`,
            provider: "busha",
            providerRef: `${providerRef}_refund`,
          });
        }
      }
      return;
    }

    const status =
      eventType === "transfer.completed" ||
      eventType === "transfer.funds_converted" ||
      eventType === "transfer.funds_delivered" ||
      eventType === "transfer.funds_received"
        ? "SUCCESS"
        : eventType === "transfer.failed" || eventType === "transfer.cancelled"
          ? "FAILED"
          : order.status;

    await prisma.cryptoOrder.update({
      where: { id: order.id },
      data: {
        status,
        providerPayload: asJson({ ...asRecord(order.providerPayload), webhook: data, eventType }),
      },
    });

    if (order.transactionId) {
      await prisma.transaction.update({
        where: { id: order.transactionId },
        data: {
          status: status === "SUCCESS" ? "SUCCESS" : status === "FAILED" ? "FAILED" : "PROCESSING",
          providerRef,
        },
      });
    }

    // Credit fiat/crypto leg once when Busha confirms the conversion.
    if (status === "SUCCESS") {
      const payload = asRecord(order.providerPayload);
      if (payload.creditSettled) return;

      const creditCurrency = str(payload.creditCurrency)?.toUpperCase();
      const creditAmount =
        num(payload.creditAmount) ??
        num(data.target_amount) ??
        Number(order.quoteAmount);

      let receiptTransactionId: string | undefined;
      if (creditCurrency && creditAmount > 0) {
        const already = await prisma.transaction.findFirst({
          where: {
            userId: order.userId,
            provider: "busha",
            providerRef: `${providerRef}_credit`,
            type: { in: ["CRYPTO_BUY", "CRYPTO_SELL"] },
          },
        });
        if (!already) {
          if (["USDT", "BTC", "ETH"].includes(creditCurrency)) {
            await prisma.wallet.upsert({
              where: {
                userId_currency: {
                  userId: order.userId,
                  currency: creditCurrency as "USDT" | "BTC" | "ETH",
                },
              },
              create: {
                userId: order.userId,
                currency: creditCurrency as "USDT" | "BTC" | "ETH",
                isVirtual: true,
                available: 0,
                pending: 0,
              },
              update: {},
            });
          }
          const receipt = await walletService.credit({
            userId: order.userId,
            currency: creditCurrency as "NGN" | "USD" | "SAR" | "USDT" | "BTC" | "ETH",
            amount: creditAmount,
            type: order.side === "BUY" ? "CRYPTO_BUY" : "CRYPTO_SELL",
            description: `${order.side} credit ${creditCurrency}`,
            provider: "busha",
            providerRef: `${providerRef}_credit`,
            metadata: asJson({ orderId: order.id, eventType, webhook: data }),
          });
          receiptTransactionId = receipt.id;
        } else {
          receiptTransactionId = already.id;
        }
      }

      await prisma.cryptoOrder.update({
        where: { id: order.id },
        data: {
          providerPayload: asJson({
            ...payload,
            webhook: data,
            eventType,
            creditSettled: true,
            ...(receiptTransactionId ? { receiptTransactionId } : {}),
          }),
        },
      });
    }

    if (status === "FAILED" && order.transactionId) {
      const payload = asRecord(order.providerPayload);
      // Bank-funded buys never debited the wallet — nothing to refund.
      if (payload.walletDebited === false || payload.payInType === "temporary_bank_account") {
        await prisma.transaction.update({
          where: { id: order.transactionId },
          data: { status: "FAILED" },
        });
        return;
      }
      const debitTx = await prisma.transaction.findUnique({ where: { id: order.transactionId } });
      if (debitTx && debitTx.status !== "REVERSED" && debitTx.status !== "FAILED") {
        await walletService.credit({
          userId: order.userId,
          currency: debitTx.currency,
          amount: debitTx.amount,
          type: "ADJUSTMENT",
          description: `Refund failed crypto order ${order.id}`,
          provider: "busha",
          providerRef: `${providerRef}_refund`,
        });
      }
    }
  }

  async handlePagocards(payload: unknown) {
    const p = asRecord(payload);
    const eventType = this.eventType(payload);
    const event = await this.ingest("pagocards", payload, undefined, eventType);
    const eventId =
      str(p.event_id) ?? str(p.eventId) ?? str(asRecord(p.data).event_id) ?? event.id;

    try {
      await this.handlePagocardsCardEvent(p, eventType, eventId);
      return prisma.webhookEvent.update({
        where: { id: event.id },
        data: { processed: true, error: null },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Pagocards webhook processing failed";
      await prisma.webhookEvent.update({
        where: { id: event.id },
        data: { processed: false, error: message },
      });
      throw error;
    }
  }

  /**
   * Pagocards card webhooks — settle card→NGN withdraws once confirmed.
   * Docs list virtualcard.* events; withdraw confirmation may arrive as a withdraw-named
   * event or with the WD* transaction_id from POST …/withdraw.
   */
  private async handlePagocardsCardEvent(
    p: Record<string, unknown>,
    eventType: string | undefined,
    eventId: string,
  ) {
    const data = asRecord(p.data);
    const providerCardId =
      str(p.cardid) ?? str(p.card_id) ?? str(data.cardid) ?? str(data.card_id) ?? str(data.cardId);
    const pagoTxId =
      str(data.transaction_id) ??
      str(data.transactionId) ??
      str(data.id) ??
      str(data.reference) ??
      str(p.transaction_id);
    const amountUsd =
      num(data.display_amount) ??
      (num(data.amount) != null && Number(data.amount) >= 1000
        ? Number(data.amount) / 1_000_000
        : num(data.amount));
    const status = (str(data.status) ?? str(p.status) ?? "").toLowerCase();
    const evt = (eventType ?? "").toLowerCase();
    const looksLikeWithdraw =
      evt.includes("withdraw") ||
      (pagoTxId?.toUpperCase().startsWith("WD") ?? false) ||
      (str(data.transaction_type) ?? "").toLowerCase().includes("withdraw");

    if (!looksLikeWithdraw && !pagoTxId?.toUpperCase().startsWith("WD")) {
      return;
    }

    if (status === "failed" || status === "fail") {
      return;
    }

    if (status && !["completed", "success", "2", ""].includes(status) && looksLikeWithdraw) {
      return;
    }

    await cardsService.settleWithdrawToNgn({
      providerCardId,
      pagoTxId,
      amountUsd,
      eventId,
    });
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
