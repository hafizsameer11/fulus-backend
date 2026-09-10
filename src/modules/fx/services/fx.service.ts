import { Prisma, type WalletCurrency } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../../lib/prisma.js";
import { AppError, NotFoundError } from "../../../lib/errors.js";
import { makeReference } from "../../../lib/http.js";

const FIAT = ["NGN", "USD", "SAR"] as const;

export const quoteSchema = z.object({
  fromCurrency: z.enum(FIAT),
  toCurrency: z.enum(FIAT),
  amount: z.number().positive(),
});

export const swapSchema = quoteSchema.extend({
  idempotencyKey: z.string().min(8).optional(),
});

export const upsertFxSchema = z.object({
  baseCurrency: z.enum(FIAT),
  quoteCurrency: z.enum(FIAT),
  midRate: z.number().positive(),
  baseBps: z.number().int().min(0).max(5000).optional(),
  tier1Bps: z.number().int().min(0).max(5000).optional(),
  tier2Bps: z.number().int().min(0).max(5000).optional(),
  tier3Bps: z.number().int().min(0).max(5000).optional(),
  overrideRate: z.number().positive().nullable().optional(),
  overrideNote: z.string().optional(),
  active: z.boolean().optional(),
});

function clientRate(mid: Prisma.Decimal, baseBps: number, tierBps: number, override?: Prisma.Decimal | null) {
  if (override) return new Prisma.Decimal(override);
  const spread = 1 + (baseBps + tierBps) / 10_000;
  return new Prisma.Decimal(mid).mul(spread);
}

export class FxService {
  async listRates() {
    return prisma.fxRate.findMany({
      where: { active: true },
      orderBy: [{ baseCurrency: "asc" }, { quoteCurrency: "asc" }],
    });
  }

  async upsertRate(input: z.infer<typeof upsertFxSchema>, createdBy?: string) {
    if (input.baseCurrency === input.quoteCurrency) {
      throw new AppError("Currencies must differ");
    }
    return prisma.fxRate.upsert({
      where: {
        baseCurrency_quoteCurrency: {
          baseCurrency: input.baseCurrency,
          quoteCurrency: input.quoteCurrency,
        },
      },
      create: {
        baseCurrency: input.baseCurrency,
        quoteCurrency: input.quoteCurrency,
        midRate: input.midRate,
        baseBps: input.baseBps ?? 90,
        tier1Bps: input.tier1Bps ?? 35,
        tier2Bps: input.tier2Bps ?? 12,
        tier3Bps: input.tier3Bps ?? 0,
        overrideRate: input.overrideRate ?? null,
        overrideNote: input.overrideNote,
        active: input.active ?? true,
        createdBy: createdBy ?? "admin",
      },
      update: {
        midRate: input.midRate,
        baseBps: input.baseBps,
        tier1Bps: input.tier1Bps,
        tier2Bps: input.tier2Bps,
        tier3Bps: input.tier3Bps,
        overrideRate: input.overrideRate === undefined ? undefined : input.overrideRate,
        overrideNote: input.overrideNote,
        active: input.active,
        createdBy: createdBy ?? "admin",
      },
    });
  }

  async quote(userId: string, input: z.infer<typeof quoteSchema>) {
    if (input.fromCurrency === input.toCurrency) {
      throw new AppError("Cannot swap the same currency");
    }

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const rateRow = await prisma.fxRate.findUnique({
      where: {
        baseCurrency_quoteCurrency: {
          baseCurrency: input.toCurrency,
          quoteCurrency: input.fromCurrency,
        },
      },
    });
    if (!rateRow || !rateRow.active) {
      throw new NotFoundError(`No FX rate for ${input.fromCurrency} → ${input.toCurrency}`);
    }

    const tierBps = user.kycTier >= 3 ? rateRow.tier3Bps : user.kycTier === 2 ? rateRow.tier2Bps : rateRow.tier1Bps;
    const applied = clientRate(rateRow.midRate, rateRow.baseBps, tierBps, rateRow.overrideRate);
    const fromAmount = new Prisma.Decimal(input.amount);
    const toAmount = fromAmount.mul(applied);

    return {
      fromCurrency: input.fromCurrency,
      toCurrency: input.toCurrency,
      fromAmount: fromAmount.toNumber(),
      toAmount: Number(toAmount.toFixed(8)),
      midRate: Number(rateRow.midRate),
      rateApplied: Number(applied),
      spreadBps: rateRow.baseBps + tierBps,
      fxRateId: rateRow.id,
      expiresInSec: 30,
    };
  }

  async executeSwap(userId: string, input: z.infer<typeof swapSchema>) {
    if (input.idempotencyKey) {
      const existing = await prisma.transaction.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) {
        const swap = await prisma.swap.findUnique({ where: { transactionId: existing.id } });
        return { transaction: existing, swap };
      }
    }

    const q = await this.quote(userId, input);
    const fromAmount = new Prisma.Decimal(q.fromAmount);
    const toAmount = new Prisma.Decimal(q.toAmount);

    return prisma.$transaction(async (tx) => {
      const fromWallet = await tx.wallet.findUnique({
        where: { userId_currency: { userId, currency: input.fromCurrency } },
      });
      const toWallet = await tx.wallet.findUnique({
        where: { userId_currency: { userId, currency: input.toCurrency } },
      });
      if (!fromWallet || !toWallet) throw new NotFoundError("Wallet not found");
      if (new Prisma.Decimal(fromWallet.available).lt(fromAmount)) {
        throw new AppError("Insufficient balance", 400, "INSUFFICIENT_FUNDS");
      }

      const fromAfter = new Prisma.Decimal(fromWallet.available).minus(fromAmount);
      const toAfter = new Prisma.Decimal(toWallet.available).plus(toAmount);
      const reference = makeReference("SWP");

      const transaction = await tx.transaction.create({
        data: {
          userId,
          type: "SWAP",
          status: "SUCCESS",
          amount: fromAmount,
          currency: input.fromCurrency,
          reference,
          description: `Swap ${input.fromCurrency} → ${input.toCurrency}`,
          idempotencyKey: input.idempotencyKey,
          metadata: {
            toCurrency: input.toCurrency,
            toAmount: toAmount.toString(),
            rateApplied: q.rateApplied,
          },
        },
      });

      await tx.wallet.update({ where: { id: fromWallet.id }, data: { available: fromAfter } });
      await tx.wallet.update({ where: { id: toWallet.id }, data: { available: toAfter } });

      await tx.ledgerEntry.create({
        data: {
          walletId: fromWallet.id,
          transactionId: transaction.id,
          type: "DEBIT",
          amount: fromAmount,
          balanceAfter: fromAfter,
          description: transaction.description,
        },
      });
      await tx.ledgerEntry.create({
        data: {
          walletId: toWallet.id,
          transactionId: transaction.id,
          type: "CREDIT",
          amount: toAmount,
          balanceAfter: toAfter,
          description: transaction.description,
        },
      });

      const swap = await tx.swap.create({
        data: {
          userId,
          transactionId: transaction.id,
          fromCurrency: input.fromCurrency,
          toCurrency: input.toCurrency,
          fromAmount,
          toAmount,
          rateApplied: q.rateApplied,
          midRate: q.midRate,
          spreadBps: q.spreadBps,
          fxRateId: q.fxRateId,
          status: "SUCCESS",
        },
      });

      return { transaction, swap };
    });
  }
}

export const fxService = new FxService();
