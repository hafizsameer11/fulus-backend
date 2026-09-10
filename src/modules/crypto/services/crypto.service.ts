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
  simulateProviders,
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
};

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

async function ensureCryptoWallet(userId: string, currency: WalletCurrency) {
  return prisma.wallet.upsert({
    where: { userId_currency: { userId, currency } },
    create: { userId, currency, isVirtual: true, available: 0, pending: 0 },
    update: {},
  });
}

export class CryptoService {
  async balances(userId: string) {
    if (useBushaLive()) return bushaClient.listBalances();

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
    if (useBushaLive()) return bushaClient.getRates();
    return Object.entries(SIM_RATES).map(([currency, usd]) => ({
      currency,
      usd,
      simulated: true,
    }));
  }

  async createQuote(input: z.infer<typeof quoteSchema>) {
    if (useBushaLive()) {
      return bushaClient.createQuote({
        side: input.side.toLowerCase(),
        base_currency: input.baseCurrency,
        quote_currency: input.quoteCurrency,
        amount: String(input.amount),
      });
    }

    const amount = Number(input.amount);
    const baseUsd = SIM_RATES[input.baseCurrency.toUpperCase()] ?? 1;
    const quoteUsd = SIM_RATES[input.quoteCurrency.toUpperCase()] ?? (input.quoteCurrency === "NGN" ? 1 / 1580 : input.quoteCurrency === "SAR" ? 1 / 3.75 : 1);

    let receiveAmount: number;
    if (input.side === "BUY") {
      // pay quoteCurrency amount, receive baseCurrency
      const payUsd = amount * (input.quoteCurrency === "USD" ? 1 : quoteUsd);
      receiveAmount = payUsd / baseUsd;
    } else {
      // sell baseCurrency amount, receive quoteCurrency
      const sellUsd = amount * baseUsd;
      receiveAmount = sellUsd / (input.quoteCurrency === "USD" ? 1 : quoteUsd);
    }

    return {
      id: simRef("CQ"),
      side: input.side,
      base_currency: input.baseCurrency,
      quote_currency: input.quoteCurrency,
      amount: String(amount),
      receive_amount: receiveAmount.toFixed(8),
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
    const amount = Number(input.amount);
    const debitCurrency = (input.side === "BUY" ? input.quoteCurrency : input.baseCurrency) as WalletCurrency;
    const creditCurrency = (input.side === "BUY" ? input.baseCurrency : input.quoteCurrency) as WalletCurrency;

    if (["USDT", "BTC", "ETH"].includes(creditCurrency)) {
      await ensureCryptoWallet(userId, creditCurrency);
    }
    if (["USDT", "BTC", "ETH"].includes(debitCurrency)) {
      await ensureCryptoWallet(userId, debitCurrency);
    }

    const quote = await this.createQuote(input);
    const receiveAmount = Number(
      (quote as { receive_amount?: string }).receive_amount ??
        (quote as { receiveAmount?: number }).receiveAmount ??
        amount,
    );

    const walletTx = await walletService.debit({
      userId,
      currency: debitCurrency,
      amount,
      type: input.side === "BUY" ? "CRYPTO_BUY" : "CRYPTO_SELL",
      description: `${input.side} ${input.baseCurrency}/${input.quoteCurrency}`,
      provider: useBushaLive() ? "busha" : "simulated",
    });

    try {
      let providerResult: Record<string, unknown>;
      if (useBushaLive()) {
        providerResult = (await bushaClient.createPayment({
          quote_amount: String(input.amount),
          quote_currency: input.quoteCurrency,
          source_currency: input.baseCurrency,
          target_currency: input.baseCurrency,
          reference: walletTx.reference,
          pay_in: input.network ? { type: "address", network: input.network } : { type: "balance" },
          additional_info: { reference: walletTx.reference },
          dry_run: false,
        })) as Record<string, unknown>;
      } else {
        providerResult = { simulated: true, id: simRef("BU") };
        // Credit the other side locally
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
          baseCurrency: input.baseCurrency,
          quoteCurrency: input.quoteCurrency,
          amount,
          quoteAmount: receiveAmount,
          rate: receiveAmount / amount,
          network: input.network,
          provider: useBushaLive() ? "busha" : "simulated",
          providerRef: typeof providerResult.id === "string" ? providerResult.id : makeReference("BU"),
          status: "SUCCESS",
          providerPayload: asJson(providerResult),
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
    const currency = input.currency.toUpperCase();
    const network = input.network;
    const existing = await prisma.cryptoAddress.findUnique({
      where: { userId_currency_network: { userId, currency, network } },
    });
    if (existing) return existing;

    const address = useBushaLive()
      ? simCryptoAddress(currency, network, userId) // live address create not wired yet
      : simCryptoAddress(currency, network, userId);

    return prisma.cryptoAddress.create({
      data: {
        userId,
        currency,
        network,
        address,
        provider: useBushaLive() ? "busha" : "simulated",
      },
    });
  }

  async listAddresses(userId: string) {
    return prisma.cryptoAddress.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  }

  async send(userId: string, input: z.infer<typeof sendSchema>) {
    const currency = input.currency.toUpperCase() as WalletCurrency;
    if (!["USDT", "BTC", "ETH"].includes(currency)) {
      throw new AppError("Unsupported crypto currency");
    }
    await ensureCryptoWallet(userId, currency);

    const walletTx = await walletService.debit({
      userId,
      currency,
      amount: input.amount,
      type: "CRYPTO_SEND",
      description: `Send ${currency} to ${input.address.slice(0, 10)}…`,
      provider: simulateProviders() || !useBushaLive() ? "simulated" : "busha",
      metadata: asJson({
        address: input.address,
        network: input.network,
        memo: input.memo,
      }),
    });

    return {
      transaction: walletTx,
      status: "SUCCESS",
      simulated: !useBushaLive(),
      providerRef: simRef("SEND"),
    };
  }

  /** Simulate an inbound crypto deposit credit (demo faucet). */
  async simulateReceive(userId: string, input: z.infer<typeof receiveSchema> & { amount?: number }) {
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
}

export const cryptoService = new CryptoService();
