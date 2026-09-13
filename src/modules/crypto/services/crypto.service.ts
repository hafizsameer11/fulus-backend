import { z } from "zod";
import type { Prisma, WalletCurrency } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { AppError, NotFoundError } from "../../../lib/errors.js";
import { makeReference } from "../../../lib/http.js";
import { bushaClient } from "../../../providers/busha/client.js";
import { walletService } from "../../wallet/services/wallet.service.js";
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

export class CryptoService {
  async coins() {
    if (useBushaLive()) {
      try {
        const crypto = unwrapList(await bushaClient.listCurrencies({ type: "crypto" }));
        const stable = unwrapList(await bushaClient.listCurrencies({ type: "stablecoin" }));
        const merged = [...crypto, ...stable];
        if (merged.length) {
          return merged.map((c) => ({
            code: String(c.code ?? "").toUpperCase(),
            name: String(c.name ?? c.display_name ?? c.code ?? ""),
            displayName: String(c.display_name ?? c.name ?? c.code ?? ""),
            type: String(c.type ?? "crypto"),
            decimals: String(c.decimals ?? c.precision ?? "8"),
            icon: typeof c.icon === "string" ? c.icon : null,
            deposit: Boolean(c.deposit ?? true),
            withdrawal: Boolean(c.withdrawal ?? true),
            defaultNetwork: typeof c.default_network === "string" ? c.default_network : null,
            supportedNetworks: Array.isArray(c.supported_networks) ? c.supported_networks : [],
            provider: "busha",
          })).filter((c) => c.code);
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
      defaultNetwork: null,
      supportedNetworks: [],
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

  async rates() {
    if (useBushaLive()) {
      const raw = await bushaClient.getRates();
      const list = unwrapList(raw);
      if (list.length) {
        return list.map((r) => ({
          currency: String(r.currency ?? r.code ?? r.base_currency ?? "").toUpperCase(),
          usd: Number(r.usd ?? r.price_usd ?? r.rate ?? r.price ?? 0),
          provider: "busha",
        })).filter((r) => r.currency);
      }
      return raw;
    }
    return Object.entries(SIM_RATES).map(([currency, usd]) => ({
      currency,
      usd,
      simulated: true,
    }));
  }

  async createQuote(input: z.infer<typeof quoteSchema>, customerId?: string) {
    const amount = Number(input.amount);
    const base = input.baseCurrency.toUpperCase();
    const quote = input.quoteCurrency.toUpperCase();

    if (useBushaLive()) {
      // BUY: pay quote (NGN/USD) → receive base (BTC)
      // SELL: pay base (BTC) → receive quote (NGN/USD)
      const body =
        input.side === "BUY"
          ? {
              source_currency: quote,
              target_currency: base,
              source_amount: String(amount),
              pay_in: { type: "balance" },
              pay_out: { type: "balance" },
            }
          : {
              source_currency: base,
              target_currency: quote,
              source_amount: String(amount),
              pay_in: { type: "balance" },
              pay_out: { type: "balance" },
            };

      const raw = await bushaClient.createQuote(body, customerId);
      const data = unwrapData(raw);
      const receiveAmount = Number(
        strOf(data, ["target_amount", "receive_amount", "receiveAmount"]) ?? amount,
      );
      const rate = Number(asRecord(data.rate).rate ?? receiveAmount / amount);
      return {
        id: strOf(data, ["id", "reference"]) ?? simRef("CQ"),
        side: input.side,
        base_currency: base,
        quote_currency: quote,
        amount: String(amount),
        receive_amount: String(receiveAmount),
        target_amount: String(receiveAmount),
        source_amount: strOf(data, ["source_amount"]) ?? String(amount),
        rate: String(rate),
        provider: "busha",
        raw: data,
        expires_at: strOf(data, ["expires_at"]),
      };
    }

    const baseUsd = SIM_RATES[base] ?? 1;
    const quoteUsd =
      SIM_RATES[quote] ?? (quote === "NGN" ? 1 / 1580 : quote === "SAR" ? 1 / 3.75 : 1);

    let receiveAmount: number;
    if (input.side === "BUY") {
      const payUsd = amount * (quote === "USD" ? 1 : quoteUsd);
      receiveAmount = payUsd / baseUsd;
    } else {
      const sellUsd = amount * baseUsd;
      receiveAmount = sellUsd / (quote === "USD" ? 1 : quoteUsd);
    }

    return {
      id: simRef("CQ"),
      side: input.side,
      base_currency: base,
      quote_currency: quote,
      amount: String(amount),
      receive_amount: receiveAmount.toFixed(8),
      target_amount: receiveAmount.toFixed(8),
      rate: (receiveAmount / amount).toFixed(8),
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
    const quote = await this.createQuote(input, customer?.bushaCustomerId ?? undefined);
    const receiveAmount = Number(quote.receive_amount ?? quote.target_amount ?? amount);

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
      }),
    });

    try {
      let providerResult: Record<string, unknown>;
      let providerRef: string;
      let status: "SUCCESS" | "PROCESSING" = "SUCCESS";

      if (live) {
        // Quote → Transfer (balance→balance). Fiat/crypto credit waits for Busha webhook.
        const quoteId = quote.id;
        if (!quoteId) throw new AppError("Busha quote missing id", 502);
        // Fresh quote immediately before transfer (quotes expire quickly).
        const fresh = await this.createQuote(input, customer!.bushaCustomerId!);
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
