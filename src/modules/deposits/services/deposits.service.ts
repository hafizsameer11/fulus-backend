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
   * Start a card → NGN wallet deposit.
   * Returns a WebView checkout URL that loads FlutterwaveCheckout (inline) with the public key.
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
      /** WebView opens this HTML page — loads FlutterwaveCheckout with public key. */
      checkoutUrl,
      /** @deprecated use checkoutUrl — kept for older clients */
      paymentLink: checkoutUrl,
      publicKey: live ? env.FLUTTERWAVE_PUBLIC_KEY : "",
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
      provider: live ? "flutterwave" : "flutterwave-sim",
    };
  }

  /** HTML page for in-app WebView: FlutterwaveCheckout (inline) or simulate UI. */
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
    const instructions = asRecord(deposit.instructions);
    const txRef = deposit.providerRef ?? query.tx_ref ?? "";
    const amount = Number(meta.chargeAmount ?? 0);
    const currency = String(meta.payCurrency ?? "USD");
    const email = String(instructions.customerEmail ?? "user@fulus.app");
    const name = String(instructions.customerName ?? "Fulus user");
    const phone = instructions.customerPhone ? String(instructions.customerPhone) : "";
    const receiveAmount = Number(meta.receiveAmount ?? deposit.amount ?? 0);
    const simulated = deposit.provider === "flutterwave-sim" || !flutterwaveLive();
    const publicKey = env.FLUTTERWAVE_PUBLIC_KEY;

    if (simulated || !publicKey) {
      return this.buildSimulateCheckoutHtml({
        depositId: deposit.id,
        txRef,
        amount,
        currency,
        receiveAmount,
      });
    }

    return this.buildInlineCheckoutHtml({
      publicKey,
      depositId: deposit.id,
      txRef,
      amount,
      currency,
      email,
      name,
      phone,
      receiveAmount,
    });
  }

  private buildInlineCheckoutHtml(opts: {
    publicKey: string;
    depositId: string;
    txRef: string;
    amount: number;
    currency: string;
    email: string;
    name: string;
    phone: string;
    receiveAmount: number;
  }) {
    const cfg = JSON.stringify({
      public_key: opts.publicKey,
      tx_ref: opts.txRef,
      amount: opts.amount,
      currency: opts.currency,
      payment_options: "card",
      customer: {
        email: opts.email,
        name: opts.name,
        ...(opts.phone ? { phonenumber: opts.phone } : {}),
      },
      customizations: {
        title: "Fulus",
        description: `NGN wallet deposit · ₦${opts.receiveAmount.toLocaleString()}`,
      },
      meta: {
        depositId: opts.depositId,
      },
    });

    return `<!doctype html>
<html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
<title>Fulus · Pay with card</title>
<style>
  html,body{margin:0;min-height:100%;background:#0A0A0A;color:#fff;font-family:system-ui,-apple-system,sans-serif}
  .wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
  .card{max-width:380px;width:100%;background:#161616;border-radius:24px;padding:28px 22px;text-align:center}
  .badge{display:inline-flex;background:#2e1065;color:#c4b5fd;font-size:11px;font-weight:600;padding:6px 10px;border-radius:999px;margin-bottom:14px}
  h1{font-size:20px;margin:0 0 8px}p{opacity:.65;font-size:13px;line-height:1.5;margin:0 0 18px}
  .amt{font-size:28px;font-weight:700;margin:8px 0 4px}
  .sub{font-size:12px;opacity:.5;margin-bottom:20px}
  button{width:100%;border:0;border-radius:16px;background:#FFD60A;color:#0A0A0A;font-weight:700;font-size:15px;padding:16px;cursor:pointer}
  .err{color:#f87171;font-size:12px;margin-top:12px;display:none}
</style>
</head>
<body>
<div class="wrap"><div class="card">
  <span class="badge">Flutterwave · Secure</span>
  <h1>Pay with card</h1>
  <p>Visa, Mastercard &amp; Verve. Card details stay with Flutterwave.</p>
  <div class="amt">${opts.currency} ${opts.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
  <div class="sub">Wallet receives ₦${opts.receiveAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
  <button type="button" id="pay">Continue to Flutterwave</button>
  <p class="err" id="err"></p>
</div></div>
<script src="https://checkout.flutterwave.com/v3.js"></script>
<script>
(function () {
  var cfg = ${cfg};
  var depositId = ${JSON.stringify(opts.depositId)};
  function post(msg) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify(msg));
      }
    } catch (e) {}
    try { window.parent && window.parent.postMessage(msg, "*"); } catch (e2) {}
  }
  function showErr(t) {
    var el = document.getElementById("err");
    if (!el) return;
    el.style.display = "block";
    el.textContent = t;
  }
  function openCheckout() {
    if (typeof FlutterwaveCheckout !== "function") {
      showErr("Flutterwave failed to load. Check your connection.");
      return;
    }
    FlutterwaveCheckout(Object.assign({}, cfg, {
      callback: function (response) {
        post({
          type: "fulus-flw-success",
          depositId: depositId,
          tx_ref: response && (response.tx_ref || cfg.tx_ref),
          transaction_id: response && (response.transaction_id || response.id),
          status: response && response.status,
          raw: response || null
        });
      },
      onclose: function () {
        post({ type: "fulus-flw-close", depositId: depositId, tx_ref: cfg.tx_ref });
      }
    }));
  }
  document.getElementById("pay").onclick = openCheckout;
  // Auto-open once script is ready
  if (typeof FlutterwaveCheckout === "function") openCheckout();
  else {
    var n = 0;
    var t = setInterval(function () {
      n += 1;
      if (typeof FlutterwaveCheckout === "function") { clearInterval(t); openCheckout(); }
      else if (n > 40) { clearInterval(t); showErr("Timed out loading Flutterwave."); }
    }, 150);
  }
})();
</script>
</body></html>`;
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
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Simulate Flutterwave</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#0A0A0A;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#161616;border-radius:24px;padding:28px 22px;max-width:380px;width:100%}
.badge{display:inline-flex;background:#1a1a2e;color:#a78bfa;font-size:11px;font-weight:600;padding:6px 10px;border-radius:999px;margin-bottom:16px}
h1{font-size:22px;margin:0 0 8px}p{opacity:.65;font-size:13px;line-height:1.5;margin:0 0 18px}
.row{display:flex;justify-content:space-between;font-size:13px;margin:8px 0}
button{width:100%;border:0;border-radius:16px;background:#FFD60A;color:#0A0A0A;font-weight:700;font-size:15px;padding:16px;cursor:pointer;margin-top:12px}
</style></head>
<body><div class="card">
<span class="badge">SIMULATED · Flutterwave</span>
<h1>Pay with card</h1>
<p>No Flutterwave keys configured — confirm to credit the NGN wallet as if checkout succeeded.</p>
<div class="row"><span>Charge</span><strong>${opts.currency} ${opts.amount.toFixed(2)}</strong></div>
<div class="row"><span>Wallet credit</span><strong>₦${opts.receiveAmount.toLocaleString()}</strong></div>
<button type="button" id="pay">Confirm payment</button>
</div>
<script>
document.getElementById('pay').onclick=function(){
  var msg = {
    type: 'fulus-flw-success',
    depositId: ${JSON.stringify(opts.depositId)},
    tx_ref: ${JSON.stringify(opts.txRef)},
    status: 'successful',
    simulated: true
  };
  try {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify(msg));
    }
  } catch (e) {}
  try { window.parent && window.parent.postMessage(msg, '*'); } catch (e2) {}
};
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
    let verified = Boolean(opts.forceSimulate) || deposit.provider === "flutterwave-sim";
    let flwData: Record<string, unknown> | undefined = opts.providerPayload;

    if (flutterwaveLive() && !opts.forceSimulate) {
      const verify = opts.transactionId
        ? await flutterwaveClient.verifyTransaction({ id: opts.transactionId })
        : await flutterwaveClient.verifyTransaction({ tx_ref: txRef });
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
      txRef: deposit.providerRef ?? undefined,
      transactionId: query.transaction_id,
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
