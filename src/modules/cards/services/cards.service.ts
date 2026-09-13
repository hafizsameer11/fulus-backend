import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { AppError, NotFoundError } from "../../../lib/errors.js";
import { makeReference } from "../../../lib/http.js";
import { pagocardsClient } from "../../../providers/pagocards/client.js";
import { PAGO_VISA, pagoVisaFundDebitUsd, pagoVisaFundFeeUsd } from "../../../providers/pagocards/fees.js";
import { walletService } from "../../wallet/services/wallet.service.js";
import { simLast4, simRef, usePagocardsLive } from "../../../lib/simulate.js";

export const createCardSchema = z.object({
  label: z.string().min(1).max(40).optional(),
});

export const fundCardSchema = z.object({
  /** Amount that lands on the card (Pagocards takes $1 + 2% on top from merchant wallet). */
  amount: z.number().positive(),
  currency: z.enum(["USD", "NGN", "SAR"]).default("USD"),
});

export const renameCardSchema = z.object({
  label: z.string().min(1).max(40),
});

export const pinCardSchema = z.object({
  pin: z.string().regex(/^\d{4}$/),
});

export const limitsCardSchema = z.object({
  dailyLimit: z.number().positive().optional(),
  monthlyLimit: z.number().positive().optional(),
  perTxLimit: z.number().positive().optional(),
});

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function pickString(obj: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function payloadOf(card: { providerPayload: unknown }) {
  return (card.providerPayload && typeof card.providerPayload === "object"
    ? card.providerPayload
    : {}) as Record<string, unknown>;
}

export class CardsService {
  async list(userId: string) {
    return prisma.card.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  }

  async get(userId: string, cardId: string) {
    const card = await prisma.card.findFirst({ where: { id: cardId, userId } });
    if (!card) throw new NotFoundError("Card not found");
    return card;
  }

  async create(userId: string, input: z.infer<typeof createCardSchema>) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError("User not found");
    if (!user.firstName || !user.lastName) {
      throw new AppError("Complete your profile name before issuing a Visa card");
    }

    const issuanceFee = PAGO_VISA.issuanceFeeUsd;
    // Debit issuance first so we never issue a card we cannot collect for.
    const feeTx = await walletService.debit({
      userId,
      currency: "USD",
      amount: issuanceFee,
      type: "FEE",
      description: `Visa card issuance fee ($${issuanceFee})`,
      provider: usePagocardsLive() ? "pagocards" : "simulated",
      metadata: { kind: "card_issuance", amountUsd: issuanceFee },
    });

    try {
      if (!usePagocardsLive()) {
        const last4 = simLast4();
        const providerCardId = simRef("CARD");
        const now = new Date();
        return prisma.card.create({
          data: {
            userId,
            provider: "pagocards",
            providerCardId,
            brand: "VISA",
            binHint: "43",
            last4,
            expMonth: 12,
            expYear: now.getFullYear() + 3,
            label: input.label ?? "Fulus Visa",
            status: "ACTIVE",
            balance: 0,
            providerPayload: asJson({
              simulated: true,
              panMasked: `4300********${last4}`,
              cvv: "FAKE",
              issuanceFeeUsd: issuanceFee,
              issuanceFeeTxId: feeTx.id,
              billing: {
                line1: "1 Admiralty Way",
                city: "Lagos",
                country: "NG",
              },
            }),
          },
        });
      }

      const providerResult = (await pagocardsClient.createVisaCard({
        firstname: user.firstName,
        lastname: user.lastName,
        email: user.email,
      })) as Record<string, unknown>;

      const data =
        providerResult.data && typeof providerResult.data === "object"
          ? (providerResult.data as Record<string, unknown>)
          : providerResult;

      const providerCardId = pickString(data, ["cardid", "card_id", "id", "cardId"]);
      const last4 = pickString(data, ["last4", "last_4", "card_last4"]);

      return prisma.card.create({
        data: {
          userId,
          provider: "pagocards",
          providerCardId,
          brand: "VISA",
          binHint: "43",
          last4,
          label: input.label ?? "Fulus Visa",
          status: providerCardId ? "ACTIVE" : "PENDING",
          providerPayload: asJson({
            ...providerResult,
            issuanceFeeUsd: issuanceFee,
            issuanceFeeTxId: feeTx.id,
          }),
        },
      });
    } catch (error) {
      await walletService.credit({
        userId,
        currency: "USD",
        amount: issuanceFee,
        type: "ADJUSTMENT",
        description: "Refund Visa card issuance fee (create failed)",
        provider: "pagocards",
        metadata: { kind: "card_issuance_refund", feeTxId: feeTx.id },
      });
      throw error;
    }
  }

  async fund(userId: string, cardId: string, input: z.infer<typeof fundCardSchema>) {
    const card = await this.get(userId, cardId);
    if (!card.providerCardId) throw new AppError("Card is not ready for funding");

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError("User not found");

    const priorFunds = await prisma.cardFunding.count({ where: { cardId: card.id, direction: "FUND" } });
    if (priorFunds === 0 && input.amount < PAGO_VISA.minInitialFundUsd) {
      throw new AppError(`Minimum initial card fund is $${PAGO_VISA.minInitialFundUsd}`, 400);
    }

    const loadFee = pagoVisaFundFeeUsd(input.amount);
    const debitTotal = pagoVisaFundDebitUsd(input.amount);

    // User pays card amount + Pagocards load fee ($1 + 2%); only `amount` is loaded on-card.
    const walletTx = await walletService.debit({
      userId,
      currency: input.currency,
      amount: debitTotal,
      type: "CARD_FUND",
      description: `Fund Visa card ${card.last4 ?? card.id} ($${input.amount} + $${loadFee} fee)`,
      provider: usePagocardsLive() ? "pagocards" : "simulated",
      providerRef: card.providerCardId,
      metadata: {
        cardAmount: input.amount,
        loadFeeUsd: loadFee,
        feeFormula: "$1 + 2%",
      },
    });

    try {
      const providerResult = usePagocardsLive()
        ? await pagocardsClient.fundVisaCard({
            cardid: card.providerCardId,
            email: user.email,
            amount: input.amount,
          })
        : { simulated: true, funded: input.amount, cardid: card.providerCardId };

      await prisma.cardFunding.create({
        data: {
          cardId: card.id,
          transactionId: walletTx.id,
          amount: input.amount,
          direction: "FUND",
          providerRef: makeReference("PCF"),
        },
      });

      const updated = await prisma.card.update({
        where: { id: card.id },
        data: {
          balance: { increment: input.amount },
          providerPayload: asJson({
            ...payloadOf(card),
            lastFund: providerResult,
            lastLoadFeeUsd: loadFee,
          }),
        },
      });

      return {
        transaction: walletTx,
        card: updated,
        providerResult,
        fees: { cardAmount: input.amount, loadFeeUsd: loadFee, debitTotalUsd: debitTotal },
      };
    } catch (error) {
      await walletService.credit({
        userId,
        currency: input.currency,
        amount: debitTotal,
        type: "ADJUSTMENT",
        description: `Refund failed card fund ${card.id}`,
        provider: "pagocards",
      });
      throw error;
    }
  }

  async freeze(userId: string, cardId: string) {
    const card = await this.get(userId, cardId);
    if (!card.providerCardId) throw new AppError("Card is not ready");
    if (usePagocardsLive()) {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      await pagocardsClient.blockVisaCard({ cardid: card.providerCardId, email: user.email });
    }
    return prisma.card.update({ where: { id: card.id }, data: { status: "FROZEN" } });
  }

  async unfreeze(userId: string, cardId: string) {
    const card = await this.get(userId, cardId);
    if (!card.providerCardId) throw new AppError("Card is not ready");
    if (usePagocardsLive()) {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      await pagocardsClient.unblockVisaCard({ cardid: card.providerCardId, email: user.email });
    }
    return prisma.card.update({ where: { id: card.id }, data: { status: "ACTIVE" } });
  }

  async rename(userId: string, cardId: string, input: z.infer<typeof renameCardSchema>) {
    await this.get(userId, cardId);
    return prisma.card.update({ where: { id: cardId }, data: { label: input.label } });
  }

  async setPin(userId: string, cardId: string, input: z.infer<typeof pinCardSchema>) {
    const card = await this.get(userId, cardId);
    return prisma.card.update({
      where: { id: card.id },
      data: {
        providerPayload: asJson({
          ...payloadOf(card),
          pinSet: true,
          pinUpdatedAt: new Date().toISOString(),
          // Never store real PIN; simulation only marks as set.
          pinHint: `****`,
        }),
      },
    });
  }

  async setLimits(userId: string, cardId: string, input: z.infer<typeof limitsCardSchema>) {
    const card = await this.get(userId, cardId);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError("User not found");

    if (usePagocardsLive()) {
      if (!card.providerCardId) throw new AppError("Card is not ready for spend controls");
      await pagocardsClient.setSpendControls({
        cardid: card.providerCardId,
        email: user.email,
        ...(input.perTxLimit != null ? { single_transaction: String(input.perTxLimit) } : {}),
        ...(input.dailyLimit != null ? { daily: String(input.dailyLimit) } : {}),
        ...(input.monthlyLimit != null ? { monthly: String(input.monthlyLimit) } : {}),
      });
    }

    return prisma.card.update({
      where: { id: card.id },
      data: {
        providerPayload: asJson({
          ...payloadOf(card),
          dailyLimit: input.dailyLimit ?? null,
          monthlyLimit: input.monthlyLimit ?? null,
          perTxLimit: input.perTxLimit ?? null,
          limits: {
            dailyLimit: input.dailyLimit ?? null,
            monthlyLimit: input.monthlyLimit ?? null,
            perTxLimit: input.perTxLimit ?? null,
            updatedAt: new Date().toISOString(),
          },
        }),
      },
    });
  }

  async terminate(userId: string, cardId: string) {
    const card = await this.get(userId, cardId);
    return prisma.card.update({ where: { id: card.id }, data: { status: "TERMINATED" } });
  }

  async statements(userId: string, cardId: string) {
    await this.get(userId, cardId);
    const fundings = await prisma.cardFunding.findMany({
      where: { cardId },
      include: { transaction: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return fundings.map((f) => ({
      id: f.id,
      amount: f.amount,
      direction: f.direction,
      createdAt: f.createdAt,
      transaction: f.transaction,
    }));
  }
}

export const cardsService = new CardsService();
