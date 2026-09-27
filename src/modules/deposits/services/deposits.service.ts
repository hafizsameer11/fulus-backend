import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { AppError, NotFoundError } from "../../../lib/errors.js";
import { makeReference } from "../../../lib/http.js";
import { env } from "../../../config/env.js";
import { createInboxMessage } from "../../../lib/inbox.js";
import { walletService } from "../../wallet/services/wallet.service.js";
import { fxService } from "../../fx/services/fx.service.js";
import { flutterwaveClient, flutterwaveLive } from "../../../providers/flutterwave/client.js";

/** Card processing fee shown in the deposit UI (1.5%). */
export const CARD_FEE_BPS = 150;

export const createDepositSchema = z.object({
  currency: z.enum(["NGN"]).default("NGN"),
  /** Required — no live bank yet, so we settle a mock credit immediately. */
  amount: z.number().positive().max(5_000_000),
});

export const initiateCardDepositSchema = z.object({
  /** Amount the user intends to convert into the wallet (before card fee). */
  payAmount: z.number().positive().max(50_000),
  /** Currency charged on the card. */
  payCurrency: z.enum(["USD", "SAR", "NGN"]).default("USD"),
  /** Wallet that receives funds — NGN only for card deposits. */
  walletCurrency: z.enum(["NGN"]).default("NGN"),
});

function vaNumber(userId: string) {
  const digits = userId.replace(/\D/g, "").slice(-8).padStart(8, "0");
  return `90${digits}21`;
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function feeOn(amount: number) {
  return +(amount * (CARD_FEE_BPS / 10_000)).toFixed(2);
}

function redirectBase() {
  if (env.FLUTTERWAVE_REDIRECT_URL?.trim()) return env.FLUTTERWAVE_REDIRECT_URL.replace(/\/$/, "");
  return `${env.APP_URL.replace(/\/$/, "")}/api/v1/deposits/card/return`;
}

export class DepositsService {
  async ensureVirtualAccount(userId: string) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const existing = await prisma.virtualAccount.findUnique({
      where: { userId_currency_provider: { userId, currency: "NGN", provider: "fulus" } },
    });
    if (existing) return existing;

    const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email;
    return prisma.virtualAccount.create({
      data: {
        userId,
        currency: "NGN",
        provider: "fulus",
        accountName: `Fulus / ${name}`,
        accountNumber: vaNumber(userId),
        bankName: "Wema Bank",
        bankCode: "035",
        status: "ACTIVE",
      },
    });
  }

  /**
   * Mock bank deposit: credits the user's NGN wallet immediately and returns
   * a real wallet transaction (no external bank / VA webhook yet).
   */
  async createBankDeposit(userId: string, input: z.infer<typeof createDepositSchema>) {
    if (input.currency !== "NGN") {
      throw new AppError("USD and SAR are virtual — fund via swap from NGN", 400, "VIRTUAL_CURRENCY");
    }

    const va = await this.ensureVirtualAccount(userId);
    const reference = makeReference("DEP");

    const transaction = await walletService.credit({
      userId,
      currency: "NGN",
      amount: input.amount,
      type: "DEPOSIT",
      description: `Mock bank deposit · ${va.bankName}`,
      provider: "mock",
      providerRef: reference,
      metadata: {
        mock: true,
        bankName: va.bankName,
        accountNumber: va.accountNumber,
      },
    });

    const deposit = await prisma.deposit.create({
      data: {
        userId,
        method: "VIRTUAL_ACCOUNT",
        currency: "NGN",
        amount: input.amount,
        status: "SUCCESS",
        provider: "mock",
        transactionId: transaction.id,
        confirmedAt: new Date(),
        instructions: {
          bankName: va.bankName,
          accountName: va.accountName,
          accountNumber: va.accountNumber,
          bankCode: va.bankCode,
          reference,
          mock: true,
        },
      },
    });

    return { deposit, transaction, virtualAccount: va, mock: true };
  }

  /**
   * Start Flutterwave Standard Checkout for a card → NGN wallet deposit.
   * Returns a hosted payment link for the in-app WebView.
   */
  async initiateCardDeposit(userId: string, input: z.infer<typeof initiateCardDepositSchema>) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const feeAmount = feeOn(input.payAmount);
    const chargeAmount = +(input.payAmount + feeAmount).toFixed(2);

    let receiveAmount = input.payAmount;
    let rateApplied = 1;
    let midRate = 1;

    if (input.payCurrency !== input.walletCurrency) {
      const quote = await fxService.quote(userId, {
        fromCurrency: input.payCurrency,
        toCurrency: input.walletCurrency,
        amount: input.payAmount,
      });
      receiveAmount = quote.toAmount;
      rateApplied = quote.rateApplied;
      midRate = quote.midRate;
    }

    const txRef = makeReference("FLW");
    const deposit = await prisma.deposit.create({
      data: {
        userId,
        method: "CARD",
        currency: input.walletCurrency,
        amount: receiveAmount,
        status: "PENDING",
        provider: flutterwaveLive() ? "flutterwave" : "flutterwave-sim",
        providerRef: txRef,
        metadata: {
          payCurrency: input.payCurrency,
          payAmount: input.payAmount,
          feeBps: CARD_FEE_BPS,
          feeAmount,
          chargeAmount,
          receiveAmount,
          rateApplied,
          midRate,
          walletCurrency: input.walletCurrency,
        },
        instructions: {
          payCurrency: input.payCurrency,
          payAmount: input.payAmount,
          feeAmount,
          chargeAmount,
          receiveAmount,
          rateApplied,
        },
      },
    });

    const redirectUrl = `${redirectBase()}?depositId=${encodeURIComponent(deposit.id)}&tx_ref=${encodeURIComponent(txRef)}`;
    const customerName =
      [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || user.email.split("@")[0] || "Fulus user";

    let paymentLink: string;
    let simulated = false;

    if (flutterwaveLive()) {
      const result = await flutterwaveClient.createPayment({
        tx_ref: txRef,
        amount: chargeAmount,
        currency: input.payCurrency,
        redirect_url: redirectUrl,
        payment_options: "card",
        customer: {
          email: user.email,
          name: customerName,
          phonenumber: user.phone ?? undefined,
        },
        meta: {
          depositId: deposit.id,
          userId,
          walletCurrency: input.walletCurrency,
          payAmount: input.payAmount,
          receiveAmount,
        },
        customizations: {
          title: "Fulus",
          description: `${input.walletCurrency} wallet deposit`,
        },
      });
      paymentLink = String(result.data?.link ?? "");
      if (!paymentLink) {
        await prisma.deposit.update({
          where: { id: deposit.id },
          data: { status: "FAILED" },
        });
        throw new AppError("Flutterwave did not return a payment link", 502, "FLW_NO_LINK");
      }
    } else {
      simulated = true;
      paymentLink = `${env.APP_URL.replace(/\/$/, "")}/api/v1/deposits/card/simulate-checkout?tx_ref=${encodeURIComponent(txRef)}&depositId=${encodeURIComponent(deposit.id)}&redirect=${encodeURIComponent(redirectUrl)}`;
    }

    await prisma.deposit.update({
      where: { id: deposit.id },
      data: {
        instructions: asJson({
          ...asRecord(deposit.instructions),
          paymentLink,
          redirectUrl,
          simulated,
        }),
      },
    });

    return {
      depositId: deposit.id,
      txRef,
      paymentLink,
      redirectUrl,
      simulated,
      payCurrency: input.payCurrency,
      payAmount: input.payAmount,
      feeBps: CARD_FEE_BPS,
      feeAmount,
      chargeAmount,
      walletCurrency: input.walletCurrency,
      receiveAmount,
      rateApplied,
      midRate,
      provider: flutterwaveLive() ? "flutterwave" : "flutterwave-sim",
    };
  }

  /** Confirm a card deposit after Flutterwave redirect or webhook. Idempotent. */
  async settleCardDeposit(opts: {
    txRef?: string;
    depositId?: string;
    providerPayload?: Record<string, unknown>;
    forceSimulate?: boolean;
  }) {
    const deposit = opts.depositId
      ? await prisma.deposit.findUnique({ where: { id: opts.depositId } })
      : opts.txRef
        ? await prisma.deposit.findFirst({ where: { providerRef: opts.txRef, method: "CARD" } })
        : null;

    if (!deposit) throw new NotFoundError("Card deposit not found");
    if (deposit.status === "SUCCESS") {
      const transaction = deposit.transactionId
        ? await prisma.transaction.findUnique({ where: { id: deposit.transactionId } })
        : null;
      return { deposit, transaction, alreadySettled: true };
    }
    if (deposit.status !== "PENDING") {
      throw new AppError(`Deposit is ${deposit.status}`, 400, "INVALID_STATUS");
    }

    const meta = asRecord(deposit.metadata);
    const receiveAmount = Number(meta.receiveAmount ?? deposit.amount ?? 0);
    if (!(receiveAmount > 0)) throw new AppError("Invalid deposit amount");

    const txRef = deposit.providerRef ?? opts.txRef ?? "";
    let verified = Boolean(opts.forceSimulate) || deposit.provider === "flutterwave-sim";
    let flwData: Record<string, unknown> | undefined = opts.providerPayload;

    if (flutterwaveLive() && !opts.forceSimulate) {
      const verify = await flutterwaveClient.verifyTransaction({ tx_ref: txRef });
      flwData = asRecord(verify.data);
      const status = String(flwData.status ?? "").toLowerCase();
      verified = verify.status === "success" && (status === "successful" || status === "success");
      if (!verified) {
        throw new AppError("Card payment not completed yet", 402, "PAYMENT_PENDING");
      }
      const paidAmount = Number(flwData.amount ?? 0);
      const expectedCharge = Number(meta.chargeAmount ?? 0);
      if (expectedCharge > 0 && paidAmount + 0.01 < expectedCharge) {
        throw new AppError("Paid amount does not match charge", 400, "AMOUNT_MISMATCH");
      }
    }

    if (!verified) {
      throw new AppError("Unable to verify card payment", 402, "NOT_VERIFIED");
    }

    const transaction = await walletService.credit({
      userId: deposit.userId,
      currency: deposit.currency,
      amount: receiveAmount,
      type: "DEPOSIT",
      description: `Card deposit · ${String(meta.payCurrency ?? "USD")} ${Number(meta.payAmount ?? 0)}`,
      provider: deposit.provider ?? "flutterwave",
      providerRef: txRef,
      metadata: asJson({
        method: "CARD",
        feeAmount: meta.feeAmount,
        chargeAmount: meta.chargeAmount,
        payCurrency: meta.payCurrency,
        payAmount: meta.payAmount,
        rateApplied: meta.rateApplied,
        flutterwave: flwData ?? null,
      }),
    });

    const updated = await prisma.deposit.update({
      where: { id: deposit.id },
      data: {
        status: "SUCCESS",
        amount: receiveAmount,
        transactionId: transaction.id,
        confirmedAt: new Date(),
        metadata: asJson({
          ...meta,
          settledAt: new Date().toISOString(),
          flutterwave: flwData ?? null,
        }),
      },
    });

    await createInboxMessage({
      userId: deposit.userId,
      title: "Card deposit successful",
      body: `${deposit.currency} ${receiveAmount.toLocaleString()} was added to your wallet.`,
      category: "wallet",
    });

    return { deposit: updated, transaction, alreadySettled: false };
  }

  async verifyCardDeposit(userId: string, query: { tx_ref?: string; depositId?: string }) {
    const deposit = query.depositId
      ? await prisma.deposit.findFirst({ where: { id: query.depositId, userId, method: "CARD" } })
      : query.tx_ref
        ? await prisma.deposit.findFirst({ where: { providerRef: query.tx_ref, userId, method: "CARD" } })
        : null;
    if (!deposit) throw new NotFoundError("Card deposit not found");

    if (deposit.status === "SUCCESS") {
      const transaction = deposit.transactionId
        ? await prisma.transaction.findUnique({ where: { id: deposit.transactionId } })
        : null;
      return { deposit, transaction, status: "SUCCESS" as const };
    }

    const settled = await this.settleCardDeposit({
      depositId: deposit.id,
      txRef: deposit.providerRef ?? undefined,
      forceSimulate: deposit.provider === "flutterwave-sim",
    });
    return { ...settled, status: "SUCCESS" as const };
  }

  async list(userId: string) {
    return prisma.deposit.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  }

  /**
   * Admin helper kept for older pending rows — settles with a real credit.
   */
  async confirm(depositId: string, amount?: number) {
    const deposit = await prisma.deposit.findUnique({ where: { id: depositId } });
    if (!deposit) throw new AppError("Deposit not found", 404, "NOT_FOUND");
    if (deposit.status !== "PENDING") throw new AppError("Deposit already settled");

    const creditAmount = Number(amount ?? deposit.amount ?? 0);
    if (!(creditAmount > 0)) throw new AppError("Amount required to confirm deposit");

    const transaction = await walletService.credit({
      userId: deposit.userId,
      currency: deposit.currency,
      amount: creditAmount,
      type: "DEPOSIT",
      description: "Bank deposit confirmed",
      provider: "mock",
    });

    const updated = await prisma.deposit.update({
      where: { id: deposit.id },
      data: {
        status: "SUCCESS",
        amount: creditAmount,
        transactionId: transaction.id,
        confirmedAt: new Date(),
        provider: "mock",
      },
    });

    return { deposit: updated, transaction, mock: true };
  }
}

export const depositsService = new DepositsService();
