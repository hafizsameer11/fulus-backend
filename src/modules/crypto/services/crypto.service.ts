import { z } from "zod";
import type { Prisma, WalletCurrency } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { AppError, NotFoundError } from "../../../lib/errors.js";
import { makeReference } from "../../../lib/http.js";
import { bushaClient } from "../../../providers/busha/client.js";
import { walletService } from "../../wallet/services/wallet.service.js";
import { fxService } from "../../fx/services/fx.service.js";
import {
  simCryptoAddress,
  simRef,
  useBushaLive,
} from "../../../lib/simulate.js";

export const quoteSchema = z.object({
  side: z.enum(["BUY", "SELL"]),
  baseCurrency: z.string().min(2),
  quoteCurrency: z.string().min(2),
  amount: z.string().or(z.number()),
});

export const createOrderSchema = quoteSchema.extend({
  network: z.string().optional(),
});

export const sendSchema = z.object({
  currency: z.string().min(2),
  network: z.string().min(2),
  amount: z.number().positive(),
  address: z.string().min(8),
  memo: z.string().optional(),
});

export const receiveSchema = z.object({
  currency: z.string().min(2),
  network: z.string().min(2).default("TRC20"),
});

const SIM_RATES: Record<string, number> = {
  BTC: 95000,
  ETH: 3500,
  USDT: 1,
  USDC: 1,
  SOL: 180,
  BNB: 600,
  XRP: 0.6,
  LTC: 90,
};

const SIM_COINS = [
  { code: "BTC", name: "Bitcoin", type: "crypto", decimals: "8", icon: null },
  { code: "ETH", name: "Ethereum", type: "crypto", decimals: "18", icon: null },
  { code: "USDT", name: "Tether", type: "stablecoin", decimals: "6", icon: null },
  { code: "USDC", name: "USD Coin", type: "stablecoin", decimals: "6", icon: null },
  { code: "SOL", name: "Solana", type: "crypto", decimals: "9", icon: null },
  { code: "BNB", name: "BNB", type: "crypto", decimals: "8", icon: null },
  { code: "XRP", name: "XRP", type: "crypto", decimals: "6", icon: null },
  { code: "LTC", name: "Litecoin", type: "crypto", decimals: "8", icon: null },
];

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function unwrapList(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.map((x) => asRecord(x));
  const root = asRecord(payload);
  if (Array.isArray(root.data)) return root.data.map((x) => asRecord(x));
  return [];
}

function amountOf(row: Record<string, unknown>, key: string): number {
  const v = row[key];
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v) || 0;
  if (v && typeof v === "object") {
    const a = (v as Record<string, unknown>).amount;
    if (typeof a === "number") return a;
    if (typeof a === "string") return Number(a) || 0;
  }
  return 0;
}

function unwrapData(payload: unknown): Record<string, unknown> {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  return Object.keys(data).length ? data : root;
}

function strOf(obj: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

/** Map app network labels to Busha network codes. */
export function bushaNetworkCode(network: string, currency: string) {
  const n = network.trim().toUpperCase();
  const c = currency.trim().toUpperCase();
  if (n === "TRC20" || n === "TRON") return "TRX";
  if (n === "ERC20" || n === "ETHEREUM") return c === "ETH" ? "ETH" : "ERC20";
  if (n === "BEP20" || n === "BSC") return "BEP20";
  if (n === "BITCOIN" || n === "BTC") return "BTC";
  if (n === "SOLANA" || n === "SOL") return "SOL";
  if (n === "POLYGON" || n === "MATIC") return "POLYGON";
  return n || c;
}

async function requireBushaCustomer(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.bushaCustomerId) {
    throw new AppError(
      "Complete Busha customer KYC before using live crypto.",
      403,
      "BUSHA_CUSTOMER_REQUIRED",
    );
  }
  return user;
}

async function ensureCryptoWallet(userId: string, currency: WalletCurrency) {
  return prisma.wallet.upsert({
    where: { userId_currency: { userId, currency } },
    create: { userId, currency, isVirtual: true, available: 0, pending: 0 },
    update: {},
  });
}

/** NIN must be PASSED before crypto trading / send / receive. */
async function requireNinKyc(userId: string) {
  const nin = await prisma.kycCheck.findFirst({
    where: { userId, type: "NIN" },
    orderBy: { createdAt: "desc" },
  });
  if (!nin || nin.status !== "PASSED") {
    if (nin?.status === "PENDING") {
      throw new AppError(
        "Your NIN verification is under review. Crypto unlocks after Prembly approves.",
        403,
        "KYC_UNDER_REVIEW",
      );
    }
    throw new AppError(
      "Complete NIN verification with a selfie before using crypto.",
      403,
      "KYC_REQUIRED",
    );
  }
}

function normalizeNetworks(raw: unknown): Array<{ code: string; name: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ code: string; name: string }> = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) {
      const code = item.trim().toUpperCase();
      out.push({ code, name: code });
      continue;
    }
    const row = asRecord(item);
    const code = strOf(row, ["code", "network", "id", "name"]);
    if (!code) continue;
    const name = strOf(row, ["name", "display_name", "label"]) ?? code.toUpperCase();
    out.push({ code: code.toUpperCase(), name });
  }
  return out;
}

function moneyAmount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) return Number(value) || 0;
  const row = asRecord(value);
  return amountOf(row, "amount");
}

export class CryptoService {
  async coins() {
    if (useBushaLive()) {
      try {
        const crypto = unwrapList(await bushaClient.listCurrencies({ type: "crypto" }));
        const stable = unwrapList(await bushaClient.listCurrencies({ type: "stablecoin" }));
        const merged = [...crypto, ...stable];
        if (merged.length) {
          return merged.map((c) => {
            const code = String(c.code ?? "").toUpperCase();
            const networks = normalizeNetworks(c.supported_networks ?? c.networks);
            const defaultNetwork =
              (typeof c.default_network === "string" ? c.default_network.toUpperCase() : null) ??
              networks[0]?.code ??
              null;
            const icon =
              (typeof c.icon === "string" && c.icon) ||
              (typeof c.logo === "string" && c.logo) ||
              (typeof c.image === "string" && c.image) ||
              null;
            return {
              code,
              name: String(c.name ?? c.display_name ?? code),
              displayName: String(c.display_name ?? c.name ?? code),
              type: String(c.type ?? "crypto"),
              decimals: String(c.decimals ?? c.precision ?? "8"),
              icon,
              deposit: Boolean(c.deposit ?? true),
              withdrawal: Boolean(c.withdrawal ?? true),
              defaultNetwork,
              supportedNetworks: networks.map((n) => n.code),
              networks,
              provider: "busha",
            };
          }).filter((c) => c.code);
        }
      } catch (err) {
        console.error("[crypto] listCurrencies failed", err);
      }
    }

    return SIM_COINS.map((c) => ({
      ...c,
      displayName: `${c.name} (${c.code})`,
      deposit: true,
      withdrawal: true,
      defaultNetwork: c.code === "USDT" ? "TRX" : c.code,
      supportedNetworks: c.code === "USDT" ? ["TRX", "ERC20", "BEP20"] : [c.code],
      networks:
        c.code === "USDT"
          ? [
              { code: "TRX", name: "TRC20" },
              { code: "ERC20", name: "ERC20" },
              { code: "BEP20", name: "BEP20" },
            ]
          : [{ code: c.code, name: c.code }],
      provider: "simulated",
      simulated: true,
    }));
  }

  async balances(userId: string) {
    await requireNinKyc(userId);

    if (useBushaLive()) {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      const raw = await bushaClient.listBalances(user?.bushaCustomerId ?? undefined);
      return unwrapList(raw).map((b) => ({
        currency: String(b.currency ?? "").toUpperCase(),
        name: typeof b.name === "string" ? b.name : undefined,
        type: typeof b.type === "string" ? b.type : undefined,
        available: amountOf(b, "available"),
        pending: amountOf(b, "pending"),
        total: amountOf(b, "total"),
        provider: "busha",
      })).filter((b) => b.currency && b.type !== "fiat");
    }

    for (const c of ["USDT", "BTC", "ETH"] as WalletCurrency[]) {
      await ensureCryptoWallet(userId, c);
    }
    const wallets = await prisma.wallet.findMany({
      where: { userId, currency: { in: ["USDT", "BTC", "ETH"] } },
    });
    return wallets.map((w) => ({
      currency: w.currency,
      available: Number(w.available),
      pending: Number(w.pending),
      simulated: true,
    }));
  }

  /**
   * Display rates for the app hero ("1 BTC = ₦…").
   * Prefer Busha /v1/pairs with NGN counter (buy_price / sell_price).
   */
  async rates() {
    if (useBushaLive()) {
      try {
        const pairsRaw = await bushaClient.listPairs({ currency: "NGN" });
        const pairs = unwrapList(pairsRaw);
        if (pairs.length) {
          // FX row for USD→NGN is stored as base=NGN, quote=USD (NGN per 1 USD).
          const fxRows = await fxService.listRates();
          const usdToNgn =
            fxRows.find((r) => r.baseCurrency === "NGN" && r.quoteCurrency === "USD" && r.active)?.midRate;
          const sarToNgn =
            fxRows.find((r) => r.baseCurrency === "NGN" && r.quoteCurrency === "SAR" && r.active)?.midRate;
          const ngnPerUsd = usdToNgn ? Number(usdToNgn) : 0;
          const ngnPerSar = sarToNgn ? Number(sarToNgn) : 0;

          return pairs
            .map((p) => {
              const base = String(p.base ?? p.base_currency ?? "").toUpperCase();
              const counter = String(p.counter ?? p.counter_currency ?? "NGN").toUpperCase();
              if (!base || counter !== "NGN") return null;
              const buyNgn = moneyAmount(p.buy_price);
              const sellNgn = moneyAmount(p.sell_price);
              const ngn = buyNgn || sellNgn;
              const midNgn = buyNgn && sellNgn ? (buyNgn + sellNgn) / 2 : ngn;
              return {
                currency: base,
                pair: String(p.id ?? `${base}NGN`),
                counter: "NGN",
                ngn: midNgn,
                buyNgn,
                sellNgn,
                usd: ngnPerUsd > 0 ? midNgn / ngnPerUsd : 0,
                sar: ngnPerSar > 0 ? midNgn / ngnPerSar : 0,
                provider: "busha",
              };
            })
            .filter(Boolean);
        }
      } catch (err) {
        console.error("[crypto] listPairs failed", err);
      }

      try {
        const raw = await bushaClient.getRates();
        const list = unwrapList(raw);
        if (list.length) {
          return list.map((r) => ({
            currency: String(r.currency ?? r.code ?? r.base_currency ?? "").toUpperCase(),
            usd: Number(r.usd ?? r.price_usd ?? r.rate ?? r.price ?? 0),
            ngn: Number(r.ngn ?? r.price_ngn ?? 0),
            provider: "busha",
          })).filter((r) => r.currency);
        }
      } catch (err) {
        console.error("[crypto] getRates failed", err);
      }
    }
    return Object.entries(SIM_RATES).map(([currency, usd]) => ({
      currency,
      usd,
      ngn: usd * 1580,
      buyNgn: usd * 1580,
      sellNgn: usd * 1570,
      provider: "simulated",
      simulated: true,
    }));
  }

  /**
   * Live Busha quote. USD/SAR are bridged through Fulus FX → NGN before Busha
   * (Busha crypto pairs are NGN-quoted).
   */
  async createQuote(input: z.infer<typeof quoteSchema>, customerId?: string, userId?: string) {
    const amount = Number(input.amount);
    const base = input.baseCurrency.toUpperCase();
    const userFiat = input.quoteCurrency.toUpperCase();
    const needsFxBridge = useBushaLive() && (userFiat === "USD" || userFiat === "SAR");

    let bushaFiat = userFiat;
    let bushaSourceAmount = amount;
    let fxBridge: Record<string, unknown> | null = null;

    if (needsFxBridge && input.side === "BUY") {
      // User pays USD/SAR → convert to NGN, then Busha buys crypto with NGN.
      if (!userId) throw new AppError("Sign in required for USD/SAR crypto quotes", 401);
      const fx = await fxService.quote(userId, {
        fromCurrency: userFiat as "USD" | "SAR",
        toCurrency: "NGN",
        amount,
      });
      bushaFiat = "NGN";
      bushaSourceAmount = Math.round(fx.toAmount * 100) / 100;
      fxBridge = {
        direction: "user_fiat_to_ngn",
        fromCurrency: userFiat,
        toCurrency: "NGN",
        fromAmount: amount,
        toAmount: bushaSourceAmount,
        rateApplied: fx.rateApplied,
      };
    }

    if (useBushaLive()) {
      if (input.side === "SELL" && needsFxBridge) {
        // Busha sells crypto → NGN, then we convert NGN → USD/SAR for the user.
        if (!userId) throw new AppError("Sign in required for USD/SAR crypto quotes", 401);
        const body = {
          source_currency: base,
          target_currency: "NGN",
          source_amount: String(amount),
          pay_in: { type: "balance" },
          pay_out: { type: "balance" },
        };
        const raw = await bushaClient.createQuote(body, customerId);
        const data = unwrapData(raw);
        const ngnOut = Number(strOf(data, ["target_amount", "receive_amount"]) ?? 0);
        const fx = await fxService.quote(userId, {
          fromCurrency: "NGN",
          toCurrency: userFiat as "USD" | "SAR",
          amount: ngnOut > 0 ? ngnOut : 1,
        });
        const userOut = ngnOut > 0 ? Math.round(fx.toAmount * 100) / 100 : 0;
        const rate = Number(asRecord(data.rate).rate ?? 0);
        return {
          id: strOf(data, ["id", "reference"]) ?? simRef("CQ"),
          side: input.side,
          base_currency: base,
          quote_currency: userFiat,
          busha_quote_currency: "NGN",
          amount: String(amount),
          receive_amount: String(userOut),
          target_amount: String(userOut),
          source_amount: String(amount),
          ngn_amount: String(ngnOut),
          rate: String(rate),
          /** NGN per 1 coin (Busha). */
          ngn_per_coin: rate || (amount > 0 ? ngnOut / amount : 0),
          /** User fiat per 1 coin. */
          user_fiat_per_coin: amount > 0 ? userOut / amount : 0,
          provider: "busha",
          fxBridge: {
            direction: "ngn_to_user_fiat",
            fromCurrency: "NGN",
            toCurrency: userFiat,
            fromAmount: ngnOut,
            toAmount: userOut,
            rateApplied: fx.rateApplied,
          },
          raw: data,
          expires_at: strOf(data, ["expires_at"]),
        };
      }

      const body =
        input.side === "BUY"
          ? {
              source_currency: bushaFiat,
              target_currency: base,
              source_amount: String(bushaSourceAmount),
              pay_in: { type: "balance" },
              pay_out: { type: "balance" },
            }
          : {
              source_currency: base,
              target_currency: bushaFiat,
              source_amount: String(amount),
              pay_in: { type: "balance" },
              pay_out: { type: "balance" },
            };

      const raw = await bushaClient.createQuote(body, customerId);
      const data = unwrapData(raw);
      const receiveAmount = Number(
        strOf(data, ["target_amount", "receive_amount", "receiveAmount"]) ?? amount,
      );
      const rate = Number(asRecord(data.rate).rate ?? receiveAmount / bushaSourceAmount);
      const userFiatPerCoin =
        input.side === "BUY" && amount > 0 ? amount / receiveAmount : receiveAmount / amount;

      return {
        id: strOf(data, ["id", "reference"]) ?? simRef("CQ"),
        side: input.side,
        base_currency: base,
        quote_currency: userFiat,
        busha_quote_currency: bushaFiat,
        amount: String(amount),
        receive_amount: String(receiveAmount),
        target_amount: String(receiveAmount),
        source_amount: strOf(data, ["source_amount"]) ?? String(bushaSourceAmount),
        ngn_amount: bushaFiat === "NGN" ? String(bushaSourceAmount) : undefined,
        rate: String(rate),
        ngn_per_coin: bushaFiat === "NGN" && input.side === "BUY" && receiveAmount > 0
          ? bushaSourceAmount / receiveAmount
          : rate,
        user_fiat_per_coin: userFiatPerCoin,
        provider: "busha",
        fxBridge,
        raw: data,
        expires_at: strOf(data, ["expires_at"]),
      };
    }

    const baseUsd = SIM_RATES[base] ?? 1;
    const quoteUsd =
      SIM_RATES[userFiat] ?? (userFiat === "NGN" ? 1 / 1580 : userFiat === "SAR" ? 1 / 3.75 : 1);

    let receiveAmount: number;
    if (input.side === "BUY") {
      const payUsd = amount * (userFiat === "USD" ? 1 : quoteUsd);
      receiveAmount = payUsd / baseUsd;
    } else {
      const sellUsd = amount * baseUsd;
      receiveAmount = sellUsd / (userFiat === "USD" ? 1 : quoteUsd);
    }

    return {
      id: simRef("CQ"),
      side: input.side,
      base_currency: base,
      quote_currency: userFiat,
      amount: String(amount),
      receive_amount: receiveAmount.toFixed(8),
      target_amount: receiveAmount.toFixed(8),
      rate: (receiveAmount / amount).toFixed(8),
      user_fiat_per_coin: amount > 0 ? (input.side === "BUY" ? amount / receiveAmount : receiveAmount / amount) : 0,
      simulated: true,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  async listOrders(userId: string) {
    return prisma.cryptoOrder.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  }

  async createOrder(userId: string, input: z.infer<typeof createOrderSchema>) {
    await requireNinKyc(userId);

    const amount = Number(input.amount);
    const debitCurrency = (input.side === "BUY" ? input.quoteCurrency : input.baseCurrency).toUpperCase() as WalletCurrency;
    const creditCurrency = (input.side === "BUY" ? input.baseCurrency : input.quoteCurrency).toUpperCase() as WalletCurrency;

    if (["USDT", "BTC", "ETH"].includes(creditCurrency)) {
      await ensureCryptoWallet(userId, creditCurrency);
    }
    if (["USDT", "BTC", "ETH"].includes(debitCurrency)) {
      await ensureCryptoWallet(userId, debitCurrency);
    }

    const live = useBushaLive();
    const customer = live ? await requireBushaCustomer(userId) : null;
    const quote = await this.createQuote(
      input,
      customer?.bushaCustomerId ?? undefined,
      userId,
    );
    const receiveAmount = Number(quote.receive_amount ?? quote.target_amount ?? amount);
    const fxBridge = (quote as { fxBridge?: Record<string, unknown> | null }).fxBridge ?? null;

    // BUY with USD/SAR: apply Fulus FX → NGN amount, debit user fiat, then Busha NGN→crypto.
    if (live && input.side === "BUY" && fxBridge && String(fxBridge.direction) === "user_fiat_to_ngn") {
      const ngnAmount = Number(fxBridge.toAmount);
      if (!(ngnAmount > 0)) throw new AppError("FX bridge produced invalid NGN amount", 502);
      const walletTx = await walletService.debit({
        userId,
        currency: debitCurrency,
        amount,
        type: "CRYPTO_BUY",
        description: `Buy ${input.baseCurrency} with ${debitCurrency}`,
        provider: "busha",
        metadata: asJson({
          kind: "crypto_order_debit",
          side: "BUY",
          creditCurrency,
          creditAmount: receiveAmount,
          fxBridge,
        }),
      });
      try {
        const quoteRaw = await bushaClient.createQuote(
          {
            source_currency: "NGN",
            target_currency: input.baseCurrency.toUpperCase(),
            source_amount: String(ngnAmount),
            pay_in: { type: "balance" },
            pay_out: { type: "balance" },
          },
          customer!.bushaCustomerId!,
        );
        const fresh = unwrapData(quoteRaw);
        const quoteId = strOf(fresh, ["id"]);
        if (!quoteId) throw new AppError("Busha quote missing id", 502);
        const creditAmt =
          Number(strOf(fresh, ["target_amount", "receive_amount"]) ?? receiveAmount) || receiveAmount;
        const transferRaw = await bushaClient.createTransfer(
          { quote_id: quoteId },
          customer!.bushaCustomerId!,
        );
        const providerResult = unwrapData(transferRaw);
        const providerRef = strOf(providerResult, ["id", "reference"]) ?? makeReference("BU");
        return prisma.cryptoOrder.create({
          data: {
            userId,
            transactionId: walletTx.id,
            side: input.side,
            baseCurrency: input.baseCurrency.toUpperCase(),
            quoteCurrency: input.quoteCurrency.toUpperCase(),
            amount,
            quoteAmount: creditAmt,
            rate: amount > 0 ? creditAmt / amount : 0,
            network: input.network,
            provider: "busha",
            providerRef,
            status: "PROCESSING",
            providerPayload: asJson({
              quote: { ...fresh, fxBridge },
              transfer: providerResult,
              creditCurrency,
              creditAmount: creditAmt,
              fxBridge,
              awaitingWebhook: true,
            }),
          },
        });
      } catch (error) {
        await walletService.credit({
          userId,
          currency: debitCurrency,
          amount,
          type: "ADJUSTMENT",
          description: `Refund failed crypto buy ${walletTx.reference}`,
          provider: "busha",
        });
        throw error;
      }
    }

    const walletTx = await walletService.debit({
      userId,
      currency: debitCurrency,
      amount,
      type: input.side === "BUY" ? "CRYPTO_BUY" : "CRYPTO_SELL",
      description: `${input.side} ${input.baseCurrency}/${input.quoteCurrency}`,
      provider: live ? "busha" : "simulated",
      metadata: asJson({
        kind: "crypto_order_debit",
        side: input.side,
        creditCurrency,
        creditAmount: receiveAmount,
        quoteId: quote.id,
        fxBridge,
      }),
    });

    try {
      let providerResult: Record<string, unknown>;
      let providerRef: string;
      let status: "SUCCESS" | "PROCESSING" = "SUCCESS";

      if (live) {
        const fresh = await this.createQuote(input, customer!.bushaCustomerId!, userId);
        const transferRaw = await bushaClient.createTransfer(
          { quote_id: fresh.id },
          customer!.bushaCustomerId!,
        );
        providerResult = unwrapData(transferRaw);
        providerRef = strOf(providerResult, ["id", "reference"]) ?? makeReference("BU");
        status = "PROCESSING";
      } else {
        providerResult = { simulated: true, id: simRef("BU") };
        providerRef = String(providerResult.id);
        if (["NGN", "USD", "SAR", "USDT", "BTC", "ETH"].includes(creditCurrency)) {
          await walletService.credit({
            userId,
            currency: creditCurrency,
            amount: receiveAmount,
            type: input.side === "BUY" ? "CRYPTO_BUY" : "CRYPTO_SELL",
            description: `${input.side} credit ${creditCurrency}`,
            provider: "simulated",
            providerRef: walletTx.reference,
          });
        }
      }

      const order = await prisma.cryptoOrder.create({
        data: {
          userId,
          transactionId: walletTx.id,
          side: input.side,
          baseCurrency: input.baseCurrency.toUpperCase(),
          quoteCurrency: input.quoteCurrency.toUpperCase(),
          amount,
          quoteAmount: receiveAmount,
          rate: receiveAmount / amount,
          network: input.network,
          provider: live ? "busha" : "simulated",
          providerRef,
          status,
          providerPayload: asJson({
            quote,
            transfer: providerResult,
            creditCurrency,
            creditAmount: receiveAmount,
            fxBridge,
            awaitingWebhook: live,
          }),
        },
      });

      return order;
    } catch (error) {
      await walletService.credit({
        userId,
        currency: debitCurrency,
        amount,
        type: "ADJUSTMENT",
        description: `Refund failed crypto order ${walletTx.reference}`,
        provider: "busha",
      });
      throw error;
    }
  }

  async getOrCreateAddress(userId: string, input: z.infer<typeof receiveSchema>) {
    await requireNinKyc(userId);

    const currency = input.currency.toUpperCase();
    const network = input.network;
    const bushaNet = bushaNetworkCode(network, currency);
    const existing = await prisma.cryptoAddress.findUnique({
      where: { userId_currency_network: { userId, currency, network } },
    });
    if (existing && !existing.address.startsWith("bc1qsim") && !existing.address.includes("sim")) {
      return existing;
    }

    if (!useBushaLive()) {
      const address = simCryptoAddress(currency, network, userId);
      if (existing) {
        return prisma.cryptoAddress.update({
          where: { id: existing.id },
          data: { address, provider: "simulated" },
        });
      }
      return prisma.cryptoAddress.create({
        data: { userId, currency, network, address, provider: "simulated" },
      });
    }

    const customer = await requireBushaCustomer(userId);
    let address: string | undefined;

    try {
      const raw = await bushaClient.getDepositAddress(currency, customer.bushaCustomerId!, bushaNet);
      const data = unwrapData(raw);
      address =
        strOf(data, ["address", "deposit_address"]) ??
        strOf(asRecord(data.pay_in), ["address"]);
    } catch {
      // Fallback: quote + transfer generates a one-shot deposit address.
      const minAmount = currency === "BTC" ? "0.0001" : currency === "ETH" ? "0.001" : "1";
      const quoteRaw = await bushaClient.createQuote(
        {
          source_currency: currency,
          target_currency: currency,
          source_amount: minAmount,
          pay_in: { type: "address", network: bushaNet },
        },
        customer.bushaCustomerId!,
      );
      const quote = unwrapData(quoteRaw);
      const quoteId = strOf(quote, ["id"]);
      if (!quoteId) throw new AppError("Could not create Busha deposit quote", 502);
      const transferRaw = await bushaClient.createTransfer({ quote_id: quoteId }, customer.bushaCustomerId!);
      const transfer = unwrapData(transferRaw);
      const payIn = asRecord(transfer.pay_in);
      address = strOf(payIn, ["address"]) ?? strOf(transfer, ["address"]);
    }

    if (!address) throw new AppError("Busha did not return a deposit address", 502);

    if (existing) {
      return prisma.cryptoAddress.update({
        where: { id: existing.id },
        data: {
          address,
          provider: "busha",
        },
      });
    }

    return prisma.cryptoAddress.create({
      data: {
        userId,
        currency,
        network,
        address,
        provider: "busha",
      },
    });
  }

  async listAddresses(userId: string) {
    return prisma.cryptoAddress.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  }

  async send(userId: string, input: z.infer<typeof sendSchema>) {
    await requireNinKyc(userId);

    const currency = input.currency.toUpperCase() as WalletCurrency;
    if (!["USDT", "BTC", "ETH"].includes(currency)) {
      throw new AppError("Unsupported crypto currency");
    }
    await ensureCryptoWallet(userId, currency);
    const bushaNet = bushaNetworkCode(input.network, currency);
    const live = useBushaLive();

    const walletTx = await walletService.debit({
      userId,
      currency,
      amount: input.amount,
      type: "CRYPTO_SEND",
      description: `Send ${currency} to ${input.address.slice(0, 10)}…`,
      provider: live ? "busha" : "simulated",
      metadata: asJson({
        address: input.address,
        network: input.network,
        bushaNetwork: bushaNet,
        memo: input.memo,
        awaitingWebhook: live,
      }),
    });

    if (!live) {
      return {
        transaction: walletTx,
        status: "SUCCESS",
        simulated: true,
        providerRef: simRef("SEND"),
      };
    }

    try {
      const customer = await requireBushaCustomer(userId);
      const quoteRaw = await bushaClient.createQuote(
        {
          source_currency: currency,
          target_currency: currency,
          source_amount: String(input.amount),
          pay_out: {
            type: "address",
            address: input.address,
            network: bushaNet,
            ...(input.memo ? { memo: input.memo } : {}),
          },
        },
        customer.bushaCustomerId!,
      );
      const quote = unwrapData(quoteRaw);
      const quoteId = strOf(quote, ["id"]);
      if (!quoteId) throw new AppError("Busha withdraw quote missing id", 502);

      const transferRaw = await bushaClient.createTransfer({ quote_id: quoteId }, customer.bushaCustomerId!);
      const transfer = unwrapData(transferRaw);
      const providerRef = strOf(transfer, ["id", "reference"]) ?? makeReference("SND");

      await prisma.transaction.update({
        where: { id: walletTx.id },
        data: {
          status: "PROCESSING",
          providerRef,
          metadata: asJson({
            address: input.address,
            network: input.network,
            bushaNetwork: bushaNet,
            memo: input.memo,
            quote,
            transfer,
            awaitingWebhook: true,
            kind: "crypto_send",
          }),
        },
      });

      return {
        transaction: await prisma.transaction.findUniqueOrThrow({ where: { id: walletTx.id } }),
        status: "PROCESSING",
        simulated: false,
        providerRef,
        transfer,
      };
    } catch (error) {
      await walletService.credit({
        userId,
        currency,
        amount: input.amount,
        type: "ADJUSTMENT",
        description: `Refund failed crypto send ${walletTx.reference}`,
        provider: "busha",
      });
      throw error;
    }
  }

  /** Simulate an inbound crypto deposit credit (demo faucet). */
  async simulateReceive(userId: string, input: z.infer<typeof receiveSchema> & { amount?: number }) {
    await requireNinKyc(userId);

    const currency = input.currency.toUpperCase() as WalletCurrency;
    await ensureCryptoWallet(userId, currency);
    const amount = input.amount ?? (currency === "BTC" ? 0.001 : currency === "ETH" ? 0.05 : 25);
    const address = await this.getOrCreateAddress(userId, input);

    const transaction = await walletService.credit({
      userId,
      currency,
      amount,
      type: "CRYPTO_RECEIVE",
      description: `Received ${currency} on ${input.network}`,
      provider: "simulated",
      metadata: asJson({ address: address.address, network: input.network, faucet: true }),
    });

    return { transaction, address, amount };
  }

  /** Soft status for mobile gate UI (does not throw). */
  async kycGate(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        kycStatus: true,
        kycTier: true,
        bushaCustomerId: true,
        bushaCustomerStatus: true,
      },
    });
    if (!user) throw new NotFoundError("User not found");

    const nin = await prisma.kycCheck.findFirst({
      where: { userId, type: "NIN" },
      orderBy: { createdAt: "desc" },
    });

    let state: "required" | "under_review" | "ready" | "rejected" = "required";
    if (nin?.status === "PASSED") state = "ready";
    else if (nin?.status === "PENDING") state = "under_review";
    else if (nin?.status === "FAILED") state = "rejected";

    return {
      state,
      kycStatus: user.kycStatus,
      kycTier: user.kycTier,
      ninStatus: nin?.status ?? null,
      bushaCustomerId: user.bushaCustomerId,
      bushaCustomerStatus: user.bushaCustomerStatus,
      message:
        state === "ready"
          ? null
          : state === "under_review"
            ? "Your NIN verification is under review. Crypto unlocks when Prembly finishes."
            : state === "rejected"
              ? "Your NIN verification was rejected. Update your details and resubmit."
              : "Complete NIN verification with a selfie to unlock crypto.",
    };
  }
}

export const cryptoService = new CryptoService();
