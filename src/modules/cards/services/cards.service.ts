import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { AppError, NotFoundError } from "../../../lib/errors.js";
import { makeReference } from "../../../lib/http.js";
import { pagocardsClient } from "../../../providers/pagocards/client.js";
import { PAGO_VISA_BIN_HINT } from "../../../providers/pagocards/constants.js";
import {
  PAGO_VISA,
  pagoVisaExtraFundUsd,
  pagoVisaFundDebitUsd,
  pagoVisaFundFeeUsd,
} from "../../../providers/pagocards/fees.js";
import { extractPagoCardSecrets, pagoDisplayBalance, pagoPayloadData, pickPagoString } from "../../../providers/pagocards/parse.js";
import { walletService } from "../../wallet/services/wallet.service.js";
import { simLast4, simRef, usePagocardsLive } from "../../../lib/simulate.js";

export const createCardSchema = z.object({
  label: z.string().min(1).max(40).optional(),
  /**
   * Desired balance on the card after create.
   * Pagocards already loads $5 by default — we only POST …/fund for the excess.
   */
  initialFund: z.number().positive().max(2500).optional(),
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
  onlineEnabled: z.boolean().optional(),
  contactlessEnabled: z.boolean().optional(),
  atmEnabled: z.boolean().optional(),
  intlEnabled: z.boolean().optional(),
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
  const hasExpiry =
    Boolean(card.expMonth && card.expYear) || Boolean(pickPagoString(p, ["expiredate", "expire_date", "expiry"]));
  return Boolean(pan && cvv && hasExpiry);
}

function toPublicCard(card: NonNullable<CardRow>) {
  const p = payloadOf(card);
  const pan = pickPagoString(p, ["pan", "card_number", "cardnumber"]) ?? null;
  const cvv = pickPagoString(p, ["cvv", "cvc"]) ?? null;
  const expiredate =
    pickPagoString(p, ["expiredate", "expire_date", "expiry"]) ??
    (card.expMonth && card.expYear
      ? `${String(card.expMonth).padStart(2, "0")}/${String(card.expYear).slice(-2)}`
      : null);

  return {
    ...card,
    // Flatten for mobile — avoids relying only on nested providerPayload
    pan,
    cvv,
    expiredate,
    cardNumber: pan,
    detailsReady: Boolean(pan && cvv && (expiredate || (card.expMonth && card.expYear))),
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
    let lastError: string | undefined;

    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(1200 * i);
      try {
        const raw = await pagocardsClient.getCard(card.providerCardId);
        const sens = extractPagoCardSecrets(raw);
        if (!sens.pan && !sens.cvv && !sens.expMonth && !sens.expiredate) {
          lastError = "provider_returned_empty_secrets";
          latest = await prisma.card.update({
            where: { id: card.id },
            data: {
              providerPayload: asJson({
                ...payloadOf(latest),
                detailsSyncAttemptAt: new Date().toISOString(),
                detailsSyncError: lastError,
                rawGet: raw,
              }),
            },
          });
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
              ...payloadOf(latest),
              ...(sens.pan ? { pan: sens.pan, card_number: sens.pan } : {}),
              ...(sens.cvv ? { cvv: sens.cvv } : {}),
              ...(sens.expiredate ? { expiredate: sens.expiredate } : {}),
              ...(sens.providerStatus ? { providerStatus: sens.providerStatus } : {}),
              detailsSyncedAt: new Date().toISOString(),
              detailsSyncError: null,
              rawGet: raw,
            }),
          },
        });

        if (hasSensitiveDetails(latest)) return latest;
      } catch (error) {
        lastError = error instanceof Error ? error.message : "provider_get_failed";
        try {
          latest = await prisma.card.update({
            where: { id: card.id },
            data: {
              providerPayload: asJson({
                ...payloadOf(latest),
                detailsSyncAttemptAt: new Date().toISOString(),
                detailsSyncError: lastError,
              }),
            },
          });
        } catch {
          // ignore persistence of sync error
        }
      }
    }

    return latest;
  }

  async list(userId: string) {
    const cards = await prisma.card.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
    const synced = await Promise.all(cards.map((c) => this.syncProviderDetails(c, { onlyIfMissing: true, retries: 2 })));
    return synced.map(toPublicCard);
  }

  async get(userId: string, cardId: string) {
    const card = await prisma.card.findFirst({ where: { id: cardId, userId } });
    if (!card) throw new NotFoundError("Card not found");
    const synced = await this.syncProviderDetails(card, {
      onlyIfMissing: false,
      retries: hasSensitiveDetails(card) ? 1 : 4,
    });
    return toPublicCard(synced);
  }

  /** Force-refresh PAN/CVV/expiry from Pagocards (used when user reveals details). */
  async reveal(userId: string, cardId: string) {
    const card = await prisma.card.findFirst({ where: { id: cardId, userId } });
    if (!card) throw new NotFoundError("Card not found");
    if (!card.providerCardId) throw new AppError("Card is not ready");
    const synced = await this.syncProviderDetails(card, { onlyIfMissing: false, retries: 5 });
    if (!hasSensitiveDetails(synced) && usePagocardsLive()) {
      throw new AppError(
        "Card details are not available yet. Wait a moment and try again.",
        409,
        "CARD_DETAILS_PENDING",
      );
    }
    return toPublicCard(synced);
  }

  async create(userId: string, input: z.infer<typeof createCardSchema>) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError("User not found");
    if (!user.firstName || !user.lastName) {
      throw new AppError("Complete your profile name before issuing a Visa card");
    }

    const desiredOnCard = Math.round((input.initialFund ?? PAGO_VISA.defaultInitialLoadUsd) * 100) / 100;
    if (desiredOnCard < PAGO_VISA.defaultInitialLoadUsd) {
      throw new AppError(`Minimum card balance is $${PAGO_VISA.defaultInitialLoadUsd}`, 400);
    }
    const extraFund = pagoVisaExtraFundUsd(desiredOnCard);
    // Pagocards fund endpoint minimum is $5 — extras below that can't be topped up separately.
    if (extraFund > 0 && extraFund < PAGO_VISA.minFundUsd) {
      throw new AppError(
        `Choose $${PAGO_VISA.defaultInitialLoadUsd} or at least $${PAGO_VISA.defaultInitialLoadUsd + PAGO_VISA.minFundUsd} (fund minimum is $${PAGO_VISA.minFundUsd} above the default load)`,
        400,
      );
    }

    const issuanceFee = PAGO_VISA.issuanceFeeUsd;
    const defaultLoad = PAGO_VISA.defaultInitialLoadUsd;
    const defaultLoadFee = pagoVisaFundFeeUsd(defaultLoad);
    const defaultDebit = pagoVisaFundDebitUsd(defaultLoad);
    const extraLoadFee = extraFund > 0 ? pagoVisaFundFeeUsd(extraFund) : 0;
    const extraDebit = extraFund > 0 ? pagoVisaFundDebitUsd(extraFund) : 0;
    const live = usePagocardsLive();

    // Debit issuance + default Pagocards load (auto-applied on create — do not fund again).
    const feeTx = await walletService.debit({
      userId,
      currency: "USD",
      amount: issuanceFee,
      type: "FEE",
      description: `Visa card issuance fee ($${issuanceFee})`,
      provider: live ? "pagocards" : "simulated",
      metadata: { kind: "card_issuance", amountUsd: issuanceFee },
    });

    let defaultFundTxId: string | undefined;
    try {
      const defaultFundTx = await walletService.debit({
        userId,
        currency: "USD",
        amount: defaultDebit,
        type: "CARD_FUND",
        description: `Visa card default load ($${defaultLoad} + $${defaultLoadFee} fee)`,
        provider: live ? "pagocards" : "simulated",
        metadata: {
          kind: "card_default_initial_load",
          cardAmount: defaultLoad,
          loadFeeUsd: defaultLoadFee,
          feeFormula: "$0.15 + 0.75%",
        },
      });
      defaultFundTxId = defaultFundTx.id;

      let extraFundTxId: string | undefined;
      if (extraFund > 0) {
        const extraFundTx = await walletService.debit({
          userId,
          currency: "USD",
          amount: extraDebit,
          type: "CARD_FUND",
          description: `Visa card extra load ($${extraFund} + $${extraLoadFee} fee)`,
          provider: live ? "pagocards" : "simulated",
          metadata: {
            kind: "card_extra_initial_load",
            cardAmount: extraFund,
            loadFeeUsd: extraLoadFee,
            feeFormula: "$0.15 + 0.75%",
          },
        });
        extraFundTxId = extraFundTx.id;
      }

      const refundCreateDebits = async () => {
        await walletService.credit({
          userId,
          currency: "USD",
          amount: issuanceFee,
          type: "ADJUSTMENT",
          description: "Refund Visa card issuance fee (create failed)",
          provider: "pagocards",
          metadata: { kind: "card_issuance_refund", feeTxId: feeTx.id },
        });
        if (defaultFundTxId) {
          await walletService.credit({
            userId,
            currency: "USD",
            amount: defaultDebit,
            type: "ADJUSTMENT",
            description: "Refund Visa card default load (create failed)",
            provider: "pagocards",
            metadata: { kind: "card_default_initial_load_refund", feeTxId: defaultFundTxId },
          });
        }
        if (extraFundTxId) {
          await walletService.credit({
            userId,
            currency: "USD",
            amount: extraDebit,
            type: "ADJUSTMENT",
            description: "Refund Visa card extra load (create failed)",
            provider: "pagocards",
            metadata: { kind: "card_extra_initial_load_refund", feeTxId: extraFundTxId },
          });
        }
      };

      try {
        if (!live) {
          const last4 = simLast4();
          const providerCardId = simRef("CARD");
          const now = new Date();
          const pan = `49372410${String(10000000 + Number(last4)).slice(-8)}`;
          const created = await prisma.card.create({
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
              balance: desiredOnCard,
              providerPayload: asJson({
                simulated: true,
                pan,
                card_number: pan,
                cvv: "123",
                expiredate: `12/${String((now.getFullYear() + 3) % 100).padStart(2, "0")}`,
                panMasked: `4937********${last4}`,
                issuanceFeeUsd: issuanceFee,
                issuanceFeeTxId: feeTx.id,
                defaultInitialLoadUsd: defaultLoad,
                defaultFundTxId,
                extraFundUsd: extraFund,
                extraFundTxId,
                billing: {
                  line1: "1 Admiralty Way",
                  city: "Lagos",
                  country: "NG",
                },
              }),
            },
          });
          await prisma.cardFunding.create({
            data: {
              cardId: created.id,
              transactionId: defaultFundTx.id,
              amount: defaultLoad,
              direction: "FUND",
              providerRef: makeReference("PCD"),
            },
          });
          if (extraFund > 0 && extraFundTxId) {
            await prisma.cardFunding.create({
              data: {
                cardId: created.id,
                transactionId: extraFundTxId,
                amount: extraFund,
                direction: "FUND",
                providerRef: makeReference("PCE"),
              },
            });
          }
          return toPublicCard(created);
        }

        // Omit initial_load — Pagocards applies defaultInitialLoadUsd ($5) automatically.
        const providerResult = await pagocardsClient.createVisaCard({
          first_name: user.firstName,
          last_name: user.lastName,
          email: user.email,
        });

        const createdSens = extractPagoCardSecrets(providerResult);
        const data = createdSens.data;
        const providerCardId = pickPagoString(data, ["card_id", "cardid", "id", "cardId"]);
        const providerBalance =
          Number.isFinite(createdSens.balance) && createdSens.balance > 0
            ? createdSens.balance
            : defaultLoad;

        let created = await prisma.card.create({
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
            balance: providerBalance,
            providerPayload: asJson({
              product_code: data.product_code ?? "us_493_visa_bin",
              providerStatus: createdSens.providerStatus,
              ...(createdSens.pan ? { pan: createdSens.pan, card_number: createdSens.pan } : {}),
              ...(createdSens.cvv ? { cvv: createdSens.cvv } : {}),
              ...(createdSens.expiredate ? { expiredate: createdSens.expiredate } : {}),
              raw: providerResult,
              issuanceFeeUsd: issuanceFee,
              issuanceFeeTxId: feeTx.id,
              defaultInitialLoadUsd: defaultLoad,
              defaultFundTxId,
              desiredOnCardUsd: desiredOnCard,
            }),
          },
        });

        await prisma.cardFunding.create({
          data: {
            cardId: created.id,
            transactionId: defaultFundTx.id,
            amount: defaultLoad,
            direction: "FUND",
            providerRef: makeReference("PCD"),
          },
        });

        // Only fund the amount above Pagocards' default $5 create load.
        if (extraFund > 0 && providerCardId && extraFundTxId) {
          const fundResult = await pagocardsClient.fundVisaCard({
            card_id: providerCardId,
            amount: extraFund,
          });
          const fundData = pagoPayloadData(fundResult);
          const fundedDisplay = pagoDisplayBalance(fundData);

          created = await prisma.card.update({
            where: { id: created.id },
            data: {
              balance:
                fundedDisplay > 0
                  ? fundedDisplay
                  : Math.round((Number(created.balance) + extraFund) * 100) / 100,
              providerPayload: asJson({
                ...payloadOf(created),
                extraFundUsd: extraFund,
                extraFundTxId,
                lastExtraFund: fundResult,
              }),
            },
          });

          await prisma.cardFunding.create({
            data: {
              cardId: created.id,
              transactionId: extraFundTxId,
              amount: extraFund,
              direction: "FUND",
              providerRef: makeReference("PCE"),
            },
          });
        }

        // Create often returns null PAN/CVV — pull from GET with a short retry.
        return toPublicCard(await this.syncProviderDetails(created, { retries: 4 }));
      } catch (error) {
        await refundCreateDebits();
        throw error;
      }
    } catch (error) {
      // Issuance debit succeeded but default fund debit failed — refund issuance only.
      if (!defaultFundTxId) {
        await walletService.credit({
          userId,
          currency: "USD",
          amount: issuanceFee,
          type: "ADJUSTMENT",
          description: "Refund Visa card issuance fee (create failed)",
          provider: "pagocards",
          metadata: { kind: "card_issuance_refund", feeTxId: feeTx.id },
        });
      }
      throw error;
    }
  }

  async fund(userId: string, cardId: string, input: z.infer<typeof fundCardSchema>) {
    const card = await this.get(userId, cardId);
    if (!card.providerCardId) throw new AppError("Card is not ready for funding");

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError("User not found");

    if (input.amount < PAGO_VISA.minFundUsd) {
      throw new AppError(`Minimum card fund is $${PAGO_VISA.minFundUsd}`, 400);
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

      // Funding often unlocks PAN/CVV on 493-BIN — refresh secrets after load.
      const synced = await this.syncProviderDetails(updated, { onlyIfMissing: true, retries: 3 });

      return {
        transaction: walletTx,
        card: toPublicCard(synced),
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
          ...(input.onlineEnabled != null ? { onlineEnabled: input.onlineEnabled } : {}),
          ...(input.contactlessEnabled != null ? { contactlessEnabled: input.contactlessEnabled } : {}),
          ...(input.atmEnabled != null ? { atmEnabled: input.atmEnabled } : {}),
          ...(input.intlEnabled != null ? { intlEnabled: input.intlEnabled } : {}),
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
