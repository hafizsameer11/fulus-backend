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
import { bushaFloatService } from "../../../providers/busha/float.js";
import { simulateProviders, useBushaLive } from "../../../lib/simulate.js";

/** Card processing fee shown in the deposit UI (1.5%). */
export const CARD_FEE_BPS = 150;

export const createDepositSchema = z.object({
  currency: z.enum(["NGN"]).default("NGN"),
  amount: z.number().positive().max(5_000_000),
});

export const bushaNgnDepositSchema = z.object({
  amount: z.number().positive().min(100).max(5_000_000),
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

export class DepositsService {
  /**
   * Fabricated Wema VA — only available in simulate mode for local demos.
   * Production NGN deposits use Busha temporary accounts (`initiateBushaNgnDeposit`).
   */
  async ensureVirtualAccount(userId: string) {
    if (!simulateProviders()) {
      throw new AppError(
        "Permanent virtual accounts are not available. Use bank deposit via Busha.",
        403,
        "VA_DISABLED",
      );
    }
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
   * Mock bank deposit (simulate mode only). Live NGN funding uses Busha.
   */
  async createBankDeposit(userId: string, input: z.infer<typeof createDepositSchema>) {
    if (!simulateProviders()) {
      throw new AppError(
        "Mock bank deposit is disabled. Use POST /deposits/busha/ngn.",
        403,
        "SIMULATE_DISABLED",
      );
    }
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
   * Start a card → NGN wallet deposit.
   * App opens FlutterwaveCheckout in a WebView (public key); API verifies with secret key.
   * `checkoutUrl` is only a simulate fallback when the app has no public key.
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
    const live = flutterwaveLive();
    const deposit = await prisma.deposit.create({
      data: {
        userId,
        method: "CARD",
        currency: input.walletCurrency,
        amount: receiveAmount,
        status: "PENDING",
        provider: live ? "flutterwave" : "flutterwave-sim",
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
          mode: "inline",
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

    const customerName =
      [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || user.email.split("@")[0] || "Fulus user";

    const apiBase = env.APP_URL.replace(/\/$/, "");
    const checkoutUrl =
      `${apiBase}/api/v1/deposits/card/inline-checkout` +
      `?depositId=${encodeURIComponent(deposit.id)}` +
      `&tx_ref=${encodeURIComponent(txRef)}`;

    await prisma.deposit.update({
      where: { id: deposit.id },
      data: {
        instructions: asJson({
          ...asRecord(deposit.instructions),
          checkoutUrl,
          customerEmail: user.email,
          customerName,
          customerPhone: user.phone ?? null,
          simulated: !live,
        }),
      },
    });

    return {
      depositId: deposit.id,
      txRef,
      /** Simulate fallback only — preferred path is in-app FlutterwaveCheckout HTML. */
      checkoutUrl,
      paymentLink: checkoutUrl,
      simulated: !live,
      customer: {
        email: user.email,
        name: customerName,
        phonenumber: user.phone ?? undefined,
      },
      payCurrency: input.payCurrency,
      payAmount: input.payAmount,
      feeBps: CARD_FEE_BPS,
      feeAmount,
      chargeAmount,
      walletCurrency: input.walletCurrency,
      receiveAmount,
      rateApplied,
      midRate,
    };
  }

  /** Simulate-only confirm page for WebView when card rails are not live. */
  async inlineCheckoutHtml(query: { depositId?: string; tx_ref?: string }) {
    const deposit = query.depositId
      ? await prisma.deposit.findUnique({ where: { id: query.depositId } })
      : query.tx_ref
        ? await prisma.deposit.findFirst({ where: { providerRef: query.tx_ref, method: "CARD" } })
        : null;

    if (!deposit || deposit.method !== "CARD") {
      throw new NotFoundError("Card deposit not found");
    }
    if (deposit.status !== "PENDING") {
      throw new AppError(`Deposit is ${deposit.status}`, 400, "INVALID_STATUS");
    }

    const meta = asRecord(deposit.metadata);
    const txRef = deposit.providerRef ?? query.tx_ref ?? "";
    const amount = Number(meta.chargeAmount ?? 0);
    const currency = String(meta.payCurrency ?? "USD");
    const receiveAmount = Number(meta.receiveAmount ?? deposit.amount ?? 0);

    return this.buildSimulateCheckoutHtml({
      depositId: deposit.id,
      txRef,
      amount,
      currency,
      receiveAmount,
    });
  }

  private buildSimulateCheckoutHtml(opts: {
    depositId: string;
    txRef: string;
    amount: number;
    currency: string;
    receiveAmount: number;
  }) {
    return `<!doctype html>
<html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<title>Pay with card</title>
<style>
html,body{margin:0;min-height:100%;background:#0A0A0A;color:#fff;font-family:system-ui,-apple-system,sans-serif;-webkit-tap-highlight-color:transparent}
.wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
.card{background:#161616;border-radius:24px;padding:28px 22px;max-width:380px;width:100%;text-align:center}
h1{font-size:22px;margin:0 0 8px}p{opacity:.65;font-size:13px;line-height:1.5;margin:0 0 18px}
.row{display:flex;justify-content:space-between;font-size:13px;margin:8px 0;text-align:left}
button{width:100%;border:0;border-radius:16px;background:#FFD60A;color:#0A0A0A;font-weight:700;font-size:15px;padding:16px;cursor:pointer;margin-top:16px;touch-action:manipulation;-webkit-appearance:none}
button:active{opacity:.85}button:disabled{opacity:.5}
.err{color:#f87171;font-size:12px;margin-top:12px;display:none}
</style></head>
<body><div class="wrap"><div class="card">
<h1>Pay with card</h1>
<p>Confirm to credit your NGN wallet. Card details are handled securely by our payment partner.</p>
<div class="row"><span>Charge</span><strong>${opts.currency} ${opts.amount.toFixed(2)}</strong></div>
<div class="row"><span>Wallet credit</span><strong>₦${opts.receiveAmount.toLocaleString()}</strong></div>
<button type="button" id="pay">Confirm payment</button>
<p class="err" id="err"></p>
</div></div>
<script>
(function () {
  var done = false;
  var btn = document.getElementById("pay");
  var err = document.getElementById("err");
  function post(msg) {
    var raw = JSON.stringify(msg);
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(raw);
        return true;
      }
    } catch (e) {}
    try { if (window.parent) window.parent.postMessage(msg, "*"); } catch (e2) {}
    return false;
  }
  function confirmPay(ev) {
    if (ev) { ev.preventDefault(); ev.stopPropagation(); }
    if (done) return;
    done = true;
    btn.disabled = true;
    btn.textContent = "Confirming…";
    var ok = post({
      type: "fulus-card-success",
      depositId: ${JSON.stringify(opts.depositId)},
      tx_ref: ${JSON.stringify(opts.txRef)},
      status: "successful",
      simulated: true
    });
    if (!ok && err) {
      done = false;
      btn.disabled = false;
      btn.textContent = "Confirm payment";
      err.style.display = "block";
      err.textContent = "Could not reach the app. Close and try again.";
    }
  }
  btn.addEventListener("click", confirmPay, false);
  btn.addEventListener("touchend", confirmPay, false);
})();
</script></body></html>`;
  }

  /** Confirm a card deposit after Flutterwave inline callback or webhook. Idempotent. */
  async settleCardDeposit(opts: {
    txRef?: string;
    depositId?: string;
    transactionId?: string | number;
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
    /** Temporary: trust app checkout callback; set FLUTTERWAVE_TRUST_CLIENT_SUCCESS=0 to verify via Flutterwave again. */
    const trustClient = env.FLUTTERWAVE_TRUST_CLIENT_SUCCESS;
    let verified =
      trustClient || Boolean(opts.forceSimulate) || deposit.provider === "flutterwave-sim";
    let flwData: Record<string, unknown> | undefined = opts.providerPayload;

    if (!trustClient && flutterwaveLive() && !opts.forceSimulate && deposit.provider !== "flutterwave-sim") {
      try {
        let verify: { status: string; data?: Record<string, unknown> };
        if (opts.transactionId != null && String(opts.transactionId) !== "") {
          try {
            verify = await flutterwaveClient.verifyTransaction({ id: opts.transactionId });
          } catch {
            verify = await flutterwaveClient.verifyTransaction({ tx_ref: txRef });
          }
        } else {
          verify = await flutterwaveClient.verifyTransaction({ tx_ref: txRef });
        }
        flwData = asRecord(verify.data);
        const status = String(flwData.status ?? "").toLowerCase();
        verified =
          verify.status === "success" &&
          (status === "successful" || status === "success" || status === "completed");
        if (!verified) {
          throw new AppError("Card payment not completed yet", 402, "PAYMENT_PENDING");
        }
        const paidAmount = Number(flwData.amount ?? 0);
        const expectedCharge = Number(meta.chargeAmount ?? 0);
        if (expectedCharge > 0 && paidAmount + 0.01 < expectedCharge) {
          throw new AppError("Paid amount does not match charge", 400, "AMOUNT_MISMATCH");
        }
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new AppError(
          "Payment succeeded at checkout but could not be verified. Set FLUTTERWAVE_SECRET_KEY to the matching FLWSECK_TEST key while testing.",
          402,
          "NOT_VERIFIED",
        );
      }
    }

    if (!verified) {
      throw new AppError("Unable to verify card payment", 402, "NOT_VERIFIED");
    }

    if (trustClient && !flwData) {
      flwData = {
        trustedClientSuccess: true,
        transaction_id: opts.transactionId ?? null,
        tx_ref: txRef,
      };
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
        trustedClientSuccess: trustClient,
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
          trustedClientSuccess: trustClient,
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

  async verifyCardDeposit(
    userId: string,
    query: { tx_ref?: string; depositId?: string; transaction_id?: string },
  ) {
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
      txRef: deposit.providerRef ?? query.tx_ref ?? undefined,
      transactionId: query.transaction_id,
      forceSimulate: deposit.provider === "flutterwave-sim" || env.FLUTTERWAVE_TRUST_CLIENT_SUCCESS,
    });
    return { ...settled, status: "SUCCESS" as const };
  }

  /**
   * PalmPay-style NGN funding: Busha temp bank credits **business master** float;
   * Fulus credits the user ledger when the transfer webhook confirms (net of fees).
   */
  async initiateBushaNgnDeposit(userId: string, input: z.infer<typeof bushaNgnDepositSchema>) {
    const master = await bushaFloatService.createMasterNgnDeposit(input.amount);
    const deposit = await prisma.deposit.create({
      data: {
        userId,
        method: "VIRTUAL_ACCOUNT",
        currency: "NGN",
        amount: master.targetAmount,
        status: "PENDING",
        provider: master.simulated ? "busha-sim" : "busha",
        providerRef: master.transferId,
        instructions: {
          bankName: master.bank.bankName,
          bankCode: master.bank.bankCode,
          accountName: master.bank.accountName,
          accountNumber: master.bank.accountNumber,
          expiresAt: master.bank.expiresAt,
          sourceAmount: master.sourceAmount,
          targetAmount: master.targetAmount,
          feeAmount: master.feeAmount,
          transferId: master.transferId,
          quoteId: master.quoteId,
          masterFloat: true,
        },
        metadata: asJson({
          kind: "busha_master_ngn_deposit",
          sourceAmount: master.sourceAmount,
          targetAmount: master.targetAmount,
          feeAmount: master.feeAmount,
          raw: master.raw,
        }),
      },
    });

    return {
      deposit,
      bankAccount: {
        ...master.bank,
        amount: master.sourceAmount,
        creditAmount: master.targetAmount,
        feeAmount: master.feeAmount,
        currency: "NGN",
        transferId: master.transferId,
      },
      simulated: master.simulated,
      live: useBushaLive(),
    };
  }

  /** Credit Fulus NGN from a confirmed Busha master deposit (idempotent). */
  async settleBushaMasterDeposit(opts: {
    transferId: string;
    creditedAmount?: number;
    webhook?: Record<string, unknown>;
  }) {
    const deposit = await prisma.deposit.findFirst({
      where: {
        providerRef: opts.transferId,
        provider: { in: ["busha", "busha-sim"] },
      },
    });
    if (!deposit) return null;
    if (deposit.status === "SUCCESS") return { deposit, alreadySettled: true };

    const meta = asRecord(deposit.metadata);
    const creditAmount =
      opts.creditedAmount ??
      Number(meta.targetAmount ?? deposit.amount ?? 0);
    if (!(creditAmount > 0)) throw new AppError("Invalid deposit credit amount");

    const transaction = await walletService.credit({
      userId: deposit.userId,
      currency: "NGN",
      amount: creditAmount,
      type: "DEPOSIT",
      description: "Bank deposit",
      provider: deposit.provider ?? "busha",
      providerRef: opts.transferId,
      metadata: asJson({
        kind: "busha_master_ngn_deposit",
        webhook: opts.webhook ?? null,
        sourceAmount: meta.sourceAmount,
        feeAmount: meta.feeAmount,
      }),
    });

    const updated = await prisma.deposit.update({
      where: { id: deposit.id },
      data: {
        status: "SUCCESS",
        amount: creditAmount,
        transactionId: transaction.id,
        confirmedAt: new Date(),
        metadata: asJson({
          ...meta,
          settledAt: new Date().toISOString(),
          webhook: opts.webhook ?? null,
        }),
      },
    });

    await createInboxMessage({
      userId: deposit.userId,
      category: "wallet",
      title: "Deposit confirmed",
      body: `₦${creditAmount.toLocaleString()} was added to your NGN wallet.`,
    });

    return { deposit: updated, transaction, alreadySettled: false };
  }

  /** Dev/sim: mark a pending Busha master deposit paid without a real bank transfer. */
  async confirmBushaNgnDeposit(userId: string, depositId: string) {
    const deposit = await prisma.deposit.findFirst({
      where: { id: depositId, userId, provider: { in: ["busha", "busha-sim"] } },
    });
    if (!deposit) throw new NotFoundError("Deposit not found");
    if (deposit.status === "SUCCESS") {
      return { deposit, alreadySettled: true };
    }
    if (useBushaLive() && deposit.provider === "busha") {
      throw new AppError("Live bank deposits settle via webhook only", 400, "LIVE_WEBHOOK_ONLY");
    }
    return this.settleBushaMasterDeposit({
      transferId: deposit.providerRef!,
      creditedAmount: Number(deposit.amount ?? 0),
      webhook: { simulated: true, confirmedByUser: true },
    });
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

    if (deposit.provider === "busha" || deposit.provider === "busha-sim") {
      return this.settleBushaMasterDeposit({
        transferId: String(deposit.providerRef),
        creditedAmount: amount ?? Number(deposit.amount ?? 0),
        webhook: { adminConfirm: true },
      });
    }

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
