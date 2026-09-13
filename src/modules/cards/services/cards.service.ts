import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { AppError, NotFoundError } from "../../../lib/errors.js";
import { makeReference } from "../../../lib/http.js";
import { pagocardsClient } from "../../../providers/pagocards/client.js";
import { PAGO_VISA_BIN_HINT } from "../../../providers/pagocards/constants.js";
import { PAGO_VISA, pagoVisaFundDebitUsd, pagoVisaFundFeeUsd } from "../../../providers/pagocards/fees.js";
import { pagoDisplayBalance, pagoPayloadData, pickPagoString } from "../../../providers/pagocards/parse.js";
import { walletService } from "../../wallet/services/wallet.service.js";
import { simLast4, simRef, usePagocardsLive } from "../../../lib/simulate.js";

export const createCardSchema = z.object({
  label: z.string().min(1).max(40).optional(),
});

export const fundCardSchema = z.object({
  /** Amount that lands on the card (Pagocards takes $0.15 + 0.75% on top from merchant wallet). */
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

function payloadOf(card: { providerPayload: unknown }) {
  return (card.providerPayload && typeof card.providerPayload === "object"
    ? card.providerPayload
    : {}) as Record<string, unknown>;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type CardRow = Awaited<ReturnType<typeof prisma.card.findFirst>> & object;

function hasSensitiveDetails(card: { expMonth: number | null; expYear: number | null; providerPayload: unknown }) {
  const p = payloadOf(card);
  const pan = pickPagoString(p, ["pan", "card_number", "cardnumber"]);
  const cvv = pickPagoString(p, ["cvv", "cvc"]);
  return Boolean(pan && cvv && card.expMonth && card.expYear);
}

function extractSensitive(data: Record<string, unknown>) {
  const pan = pickPagoString(data, ["card_number", "cardnumber", "pan", "cardNumber"]);
  const cvv = pickPagoString(data, ["cvv", "cvc"]);
  const expiredate = pickPagoString(data, ["expiredate", "expire_date", "expiry"]);
  let expMonth = Number(data.expiry_month ?? data.exp_month);
  let expYear = Number(data.expiry_year ?? data.exp_year);
  if (expiredate) {
    const m = expiredate.match(/^(\d{1,2})\s*\/\s*(\d{2,4})$/);
    if (m) {
      expMonth = Number(m[1]);
      const yy = Number(m[2]);
      expYear = yy < 100 ? 2000 + yy : yy;
    }
  }
  const last4 =
    pickPagoString(data, ["last_four", "lastfour", "last4", "last_4"]) ??
    (pan && pan.replace(/\D/g, "").length >= 4 ? pan.replace(/\D/g, "").slice(-4) : undefined);
  return {
    pan,
    cvv,
    expiredate,
    last4,
    expMonth: Number.isFinite(expMonth) && expMonth >= 1 && expMonth <= 12 ? expMonth : undefined,
    expYear: Number.isFinite(expYear) && expYear > 2000 ? expYear : undefined,
    balance: pagoDisplayBalance(data),
    providerStatus: pickPagoString(data, ["status"]),
  };
}

export class CardsService {
  /**
   * 493-BIN create responses often omit PAN/CVV; Pagocards fills them on GET.
   * @see https://pagocards.com/documentation — Get Card
   */
  private async syncProviderDetails(
    card: NonNullable<CardRow>,
    opts: { onlyIfMissing?: boolean; retries?: number } = {},
  ) {
    if (!usePagocardsLive() || !card.providerCardId) return card;
    if (opts.onlyIfMissing && hasSensitiveDetails(card)) return card;

    const attempts = Math.max(1, opts.retries ?? 1);
    let latest = card;

    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(800 * i);
      try {
        const raw = await pagocardsClient.getCard(card.providerCardId);
        const data = pagoPayloadData(raw);
        const sens = extractSensitive(data);
        if (!sens.pan && !sens.cvv && !sens.expMonth) {
          latest = card;
          continue;
        }

        latest = await prisma.card.update({
          where: { id: card.id },
          data: {
            ...(sens.last4 ? { last4: sens.last4 } : {}),
            ...(sens.expMonth != null ? { expMonth: sens.expMonth } : {}),
            ...(sens.expYear != null ? { expYear: sens.expYear } : {}),
            ...(Number.isFinite(sens.balance) ? { balance: sens.balance } : {}),
            providerPayload: asJson({
              ...payloadOf(card),
              ...(sens.pan ? { pan: sens.pan, card_number: sens.pan } : {}),
              ...(sens.cvv ? { cvv: sens.cvv } : {}),
              ...(sens.expiredate ? { expiredate: sens.expiredate } : {}),
              ...(sens.providerStatus ? { providerStatus: sens.providerStatus } : {}),
              detailsSyncedAt: new Date().toISOString(),
              rawGet: raw,
            }),
          },
        });

        if (hasSensitiveDetails(latest)) return latest;
      } catch {
        // Keep last known row; caller can still show masked card.
      }
    }

    return latest;
  }

  async list(userId: string) {
    const cards = await prisma.card.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
    return Promise.all(cards.map((c) => this.syncProviderDetails(c, { onlyIfMissing: true })));
  }

  async get(userId: string, cardId: string) {
    const card = await prisma.card.findFirst({ where: { id: cardId, userId } });
    if (!card) throw new NotFoundError("Card not found");
    return this.syncProviderDetails(card, { onlyIfMissing: false, retries: hasSensitiveDetails(card) ? 1 : 2 });
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
        const pan = `49372410${String(10000000 + Number(last4)).slice(-8)}`;
        return prisma.card.create({
          data: {
            userId,
            provider: "pagocards",
            providerCardId,
            brand: "VISA",
            binHint: PAGO_VISA_BIN_HINT,
            last4,
            expMonth: 12,
            expYear: now.getFullYear() + 3,
            label: input.label ?? "Fulus Visa",
            status: "ACTIVE",
            balance: 0,
            providerPayload: asJson({
              simulated: true,
              pan,
              card_number: pan,
              cvv: "123",
              expiredate: `12/${String((now.getFullYear() + 3) % 100).padStart(2, "0")}`,
              panMasked: `4937********${last4}`,
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

      const providerResult = await pagocardsClient.createVisaCard({
        first_name: user.firstName,
        last_name: user.lastName,
        email: user.email,
      });

      const data = pagoPayloadData(providerResult);
      const providerCardId = pickPagoString(data, ["card_id", "cardid", "id", "cardId"]);
      const createdSens = extractSensitive(data);
      const balance = pagoDisplayBalance(data);
      const providerStatus = pickPagoString(data, ["status"]);

      const created = await prisma.card.create({
        data: {
          userId,
          provider: "pagocards",
          providerCardId,
          brand: "VISA",
          binHint: PAGO_VISA_BIN_HINT,
          last4: createdSens.last4,
          ...(createdSens.expMonth != null ? { expMonth: createdSens.expMonth } : {}),
          ...(createdSens.expYear != null ? { expYear: createdSens.expYear } : {}),
          label: input.label ?? "Fulus Visa",
          status: providerCardId ? "ACTIVE" : "PENDING",
          balance,
          providerPayload: asJson({
            product_code: data.product_code ?? "us_493_visa_bin",
            providerStatus,
            ...(createdSens.pan ? { pan: createdSens.pan, card_number: createdSens.pan } : {}),
            ...(createdSens.cvv ? { cvv: createdSens.cvv } : {}),
            ...(createdSens.expiredate ? { expiredate: createdSens.expiredate } : {}),
            raw: providerResult,
            issuanceFeeUsd: issuanceFee,
            issuanceFeeTxId: feeTx.id,
          }),
        },
      });

      // Create often returns null PAN/CVV — pull from GET with a short retry.
      return this.syncProviderDetails(created, { retries: 3 });
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

    // User pays card amount + Pagocards load fee ($0.15 + 0.75%); only `amount` is loaded on-card.
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
        feeFormula: "$0.15 + 0.75%",
      },
    });

    try {
      const providerResult = usePagocardsLive()
        ? await pagocardsClient.fundVisaCard({
            card_id: card.providerCardId,
            amount: input.amount,
          })
        : { simulated: true, funded: input.amount, card_id: card.providerCardId };

      await prisma.cardFunding.create({
        data: {
          cardId: card.id,
          transactionId: walletTx.id,
          amount: input.amount,
          direction: "FUND",
          providerRef: makeReference("PCF"),
        },
      });

      const fundData = pagoPayloadData(providerResult);
      const fundedDisplay = pagoDisplayBalance(fundData);
      const balanceDelta = fundedDisplay > 0 ? fundedDisplay : input.amount;

      const updated = await prisma.card.update({
        where: { id: card.id },
        data: {
          balance: { increment: balanceDelta },
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
      await pagocardsClient.blockVisaCard({ card_id: card.providerCardId });
    }
    return prisma.card.update({ where: { id: card.id }, data: { status: "FROZEN" } });
  }

  async unfreeze(userId: string, cardId: string) {
    const card = await this.get(userId, cardId);
    if (!card.providerCardId) throw new AppError("Card is not ready");
    if (usePagocardsLive()) {
      await pagocardsClient.unblockVisaCard({ card_id: card.providerCardId });
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
    if (usePagocardsLive() && card.providerCardId) {
      await pagocardsClient.terminateCard({ card_id: card.providerCardId });
    }
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
