import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { AppError, NotFoundError, sanitizePublicCopy } from "../../../lib/errors.js";
import { makeReference } from "../../../lib/http.js";
import { pagocardsClient } from "../../../providers/pagocards/client.js";
import { PAGO_CARD_BILLING_ADDRESS, PAGO_VISA_BIN_HINT } from "../../../providers/pagocards/constants.js";
import {
  cardExtraFundUsd,
  cardFundDebitUsd,
  cardFundFeeUsd,
  resolveCardFees,
} from "../../../providers/pagocards/fees.js";
import { extractPagoCardSecrets, pagoDisplayBalance, pagoPayloadData, pickPagoString } from "../../../providers/pagocards/parse.js";
import { walletService } from "../../wallet/services/wallet.service.js";
import { fxService } from "../../fx/services/fx.service.js";
import { createInboxMessage } from "../../../lib/inbox.js";
import { simLast4, simRef, usePagocardsLive } from "../../../lib/simulate.js";
import { assertKillSwitchOff, KILL_SWITCH_KEYS } from "../../../lib/kill-switch.js";
import { securityService } from "../../security/services/security.service.js";

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
  transactionPin: z.string().regex(/^\d{4,6}$/).optional(),
});

export const withdrawCardSchema = z.object({
  /** USD to pull off the card (must leave ≥ $5). Settles to NGN after Pagocards webhook. */
  amount: z.number().positive(),
  transactionPin: z.string().regex(/^\d{4,6}$/).optional(),
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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

function limitsFromPayload(p: Record<string, unknown>) {
  const nested =
    p.limits && typeof p.limits === "object" && !Array.isArray(p.limits)
      ? (p.limits as Record<string, unknown>)
      : {};
  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  return {
    dailyLimit: num(p.dailyLimit ?? nested.dailyLimit),
    monthlyLimit: num(p.monthlyLimit ?? nested.monthlyLimit),
    perTxLimit: num(p.perTxLimit ?? nested.perTxLimit),
  };
}

/** Flat billing fields mobile `mapApiCard` reads from the card DTO / payload. */
function fixedBillingPayloadFields() {
  const b = PAGO_CARD_BILLING_ADDRESS;
  return {
    billing: { ...b },
    billingLine1: b.line1,
    billingLine2: b.line2,
    billingCity: b.city,
    billingState: b.state,
    billingZip: b.postal_code,
    billingCountry: b.country,
  };
}

function toPublicCard(card: NonNullable<CardRow>, spentThisMonth = 0) {
  const p = payloadOf(card);
  const pan = pickPagoString(p, ["pan", "card_number", "cardnumber"]) ?? null;
  const cvv = pickPagoString(p, ["cvv", "cvc"]) ?? null;
  const expiredate =
    pickPagoString(p, ["expiredate", "expire_date", "expiry"]) ??
    (card.expMonth && card.expYear
      ? `${String(card.expMonth).padStart(2, "0")}/${String(card.expYear).slice(-2)}`
      : null);
  const limits = limitsFromPayload(p);
  const billing = fixedBillingPayloadFields();

  return {
    ...card,
    // Flatten for mobile — avoids relying only on nested providerPayload
    pan,
    cvv,
    expiredate,
    cardNumber: pan,
    detailsReady: Boolean(pan && cvv && (expiredate || (card.expMonth && card.expYear))),
    spent: spentThisMonth,
    spentThisMonth,
    dailyLimit: limits.dailyLimit || null,
    monthlyLimit: limits.monthlyLimit || null,
    perTxLimit: limits.perTxLimit || null,
    // Fixed issuer AVS address for every card (not user-editable)
    ...billing,
  };
}

async function spentThisMonthByCardIds(cardIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!cardIds.length) return map;
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const rows = await prisma.cardAuthorization.groupBy({
    by: ["cardId"],
    where: {
      cardId: { in: cardIds },
      decision: { in: ["approved", "APPROVED"] },
      at: { gte: start },
    },
    _sum: { amount: true },
  });
  for (const row of rows) {
    if (!row.cardId) continue;
    map.set(row.cardId, Number(row._sum.amount ?? 0));
  }
  return map;
}

export class CardsService {
  /**
   * 404-BIN create responses may omit PAN/CVV; Pagocards fills them on GET.
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
    const spentMap = await spentThisMonthByCardIds(synced.map((c) => c.id));
    return synced.map((c) => toPublicCard(c, spentMap.get(c.id) ?? 0));
  }

  async get(userId: string, cardId: string) {
    const card = await prisma.card.findFirst({ where: { id: cardId, userId } });
    if (!card) throw new NotFoundError("Card not found");
    const synced = await this.syncProviderDetails(card, {
      onlyIfMissing: false,
      retries: hasSensitiveDetails(card) ? 1 : 4,
    });
    const spentMap = await spentThisMonthByCardIds([synced.id]);
    return toPublicCard(synced, spentMap.get(synced.id) ?? 0);
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

    const fees = await resolveCardFees();
    const desiredOnCard = Math.round((input.initialFund ?? fees.defaultInitialLoadUsd) * 100) / 100;
    if (desiredOnCard < fees.defaultInitialLoadUsd) {
      throw new AppError(`Minimum card balance is $${fees.defaultInitialLoadUsd}`, 400);
    }
    const extraFund = cardExtraFundUsd(desiredOnCard, fees.defaultInitialLoadUsd);
    // Pagocards fund endpoint minimum — extras below that can't be topped up separately.
    if (extraFund > 0 && extraFund < fees.minFundUsd) {
      throw new AppError(
        `Choose $${fees.defaultInitialLoadUsd} or at least $${fees.defaultInitialLoadUsd + fees.minFundUsd} (fund minimum is $${fees.minFundUsd} above the default load)`,
        400,
      );
    }

    const issuanceFee = fees.issuanceFeeUsd;
    const defaultLoad = fees.defaultInitialLoadUsd;
    const defaultLoadFee = cardFundFeeUsd(defaultLoad, fees);
    const defaultDebit = cardFundDebitUsd(defaultLoad, fees);
    const extraLoadFee = extraFund > 0 ? cardFundFeeUsd(extraFund, fees) : 0;
    const extraDebit = extraFund > 0 ? cardFundDebitUsd(extraFund, fees) : 0;
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
          const pan = `40472410${String(10000000 + Number(last4)).slice(-8)}`;
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
                panMasked: `4047********${last4}`,
                issuanceFeeUsd: issuanceFee,
                issuanceFeeTxId: feeTx.id,
                defaultInitialLoadUsd: defaultLoad,
                defaultFundTxId,
                extraFundUsd: extraFund,
                extraFundTxId,
                ...fixedBillingPayloadFields(),
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
              product_code: data.product_code ?? "us_404_visa_bin",
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
              ...fixedBillingPayloadFields(),
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

  async fund(
    userId: string,
    cardId: string,
    input: z.infer<typeof fundCardSchema>,
    opts?: { skipPinCheck?: boolean; idempotencyKey?: string },
  ) {
    await assertKillSwitchOff(KILL_SWITCH_KEYS.CARDS_FUND, "Card funding is temporarily disabled");
    if (!opts?.skipPinCheck) {
      await securityService.assertTransactionPin(userId, input.transactionPin);
    }
    const card = await this.get(userId, cardId);
    if (!card.providerCardId) throw new AppError("Card is not ready for funding");

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError("User not found");

    const fees = await resolveCardFees();
    if (input.amount < fees.minFundUsd) {
      throw new AppError(`Minimum card fund is $${fees.minFundUsd}`, 400, "MIN_FUND");
    }

    const loadFee = cardFundFeeUsd(input.amount, fees);
    const debitTotal = cardFundDebitUsd(input.amount, fees);

    // Always debit USD for fee math. Convert NGN/SAR → USD first so we never undercharge.
    let sourceDebited: number | undefined;
    if (input.currency !== "USD") {
      const probe = await fxService.quote(userId, {
        fromCurrency: input.currency,
        toCurrency: "USD",
        amount: 1,
      });
      if (!(probe.rateApplied > 0)) {
        throw new AppError("FX rate unavailable", 503, "FX_UNAVAILABLE");
      }
      let sourceNeeded = Math.ceil((debitTotal / probe.rateApplied) * 1e8) / 1e8;
      let q = await fxService.quote(userId, {
        fromCurrency: input.currency,
        toCurrency: "USD",
        amount: sourceNeeded,
      });
      if (q.toAmount + 1e-8 < debitTotal) {
        sourceNeeded = Math.ceil(sourceNeeded * (debitTotal / q.toAmount) * 1e8) / 1e8;
      }
      await fxService.executeSwap(userId, {
        fromCurrency: input.currency,
        toCurrency: "USD",
        amount: sourceNeeded,
        idempotencyKey: opts?.idempotencyKey ? `${opts.idempotencyKey}-fx` : undefined,
      });
      sourceDebited = sourceNeeded;
    }

    // User pays card amount + Pagocards load fee ($0.15 + 0.75%); only `amount` is loaded on-card.
    const walletTx = await walletService.debit({
      userId,
      currency: "USD",
      amount: debitTotal,
      type: "CARD_FUND",
      description: sanitizePublicCopy(
        `Fund Visa card ${card.last4 ?? card.id} ($${input.amount} + $${loadFee} fee)`,
      ),
      provider: usePagocardsLive() ? "pagocards" : "simulated",
      providerRef: card.providerCardId,
      fee: loadFee,
      metadata: {
        cardId: card.id,
        cardAmount: input.amount,
        cardAmountUsd: input.amount,
        loadFeeUsd: loadFee,
        debitTotalUsd: debitTotal,
        sourceCurrency: input.currency,
        sourceDebited: sourceDebited ?? null,
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

      // Funding often unlocks PAN/CVV on 404-BIN — refresh secrets after load.
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
        currency: "USD",
        amount: debitTotal,
        type: "ADJUSTMENT",
        description: sanitizePublicCopy(`Refund failed card fund ${card.id}`),
        provider: "pagocards",
      });
      throw error;
    }
  }

  /**
   * Pull USD off a 404-BIN card into the merchant Pagocards wallet.
   * NGN is credited only after Pagocards webhook confirmation (simulated settles immediately).
   * @see https://pagocards.com/documentation — Withdraw 4XX-BIN Card
   */
  async withdraw(userId: string, cardId: string, input: z.infer<typeof withdrawCardSchema>) {
    await securityService.assertTransactionPin(userId, input.transactionPin);
    const card = await this.get(userId, cardId);
    if (!card.providerCardId) throw new AppError("Card is not ready for withdrawal");
    if (String(card.status).toUpperCase() === "FROZEN") {
      throw new AppError("Unfreeze the card before withdrawing", 400);
    }

    const fees = await resolveCardFees();
    const amount = Math.round(input.amount * 100) / 100;
    const balance = Number(card.balance);
    const maxWithdraw = Math.round((balance - fees.minRetainBalanceUsd) * 100) / 100;
    if (maxWithdraw <= 0) {
      throw new AppError(
        `Card must keep at least $${fees.minRetainBalanceUsd}. Current balance is $${balance.toFixed(2)}.`,
        400,
      );
    }
    if (amount > maxWithdraw + 1e-9) {
      throw new AppError(
        `Maximum withdrawable is $${maxWithdraw.toFixed(2)} (must leave $${fees.minRetainBalanceUsd} on the card)`,
        400,
      );
    }

    const live = usePagocardsLive();
    const providerRef = makeReference("PCW");
    const pendingTx = await prisma.transaction.create({
      data: {
        userId,
        type: "CARD_WITHDRAW",
        status: "PROCESSING",
        amount,
        currency: "USD",
        reference: makeReference("TX"),
        provider: live ? "pagocards" : "simulated",
        providerRef,
        description: sanitizePublicCopy(
          `Withdraw $${amount} from Visa ••${card.last4 ?? "••••"} → NGN (awaiting confirmation)`,
        ),
        metadata: asJson({
          kind: "card_withdraw",
          cardId: card.id,
          providerCardId: card.providerCardId,
          amountUsd: amount,
          settleCurrency: "NGN",
          awaitingWebhook: live,
        }),
      },
    });

    try {
      const providerResult = live
        ? await pagocardsClient.withdrawVisaCard({
            card_id: card.providerCardId,
            amount,
          })
        : {
            simulated: true,
            status: "completed",
            data: {
              card_id: card.providerCardId,
              display_amount: amount,
              transaction_id: `WD_SIM_${Date.now()}`,
              wallet_transaction_id: `wallet_sim_${Date.now()}`,
            },
          };

      const data = pagoPayloadData(providerResult);
      const pagoTxId =
        pickPagoString(data, ["transaction_id", "transactionId", "id"]) ??
        pickPagoString(asRecord(providerResult), ["transaction_id"]);
      const walletTxId = pickPagoString(data, ["wallet_transaction_id", "walletTransactionId"]);
      const providerStatus = (pickPagoString(data, ["status"]) ?? "completed").toLowerCase();

      await prisma.cardFunding.create({
        data: {
          cardId: card.id,
          transactionId: pendingTx.id,
          amount,
          direction: "WITHDRAW",
          providerRef: pagoTxId ?? providerRef,
        },
      });

      const updated = await prisma.card.update({
        where: { id: card.id },
        data: {
          balance: { decrement: amount },
          providerPayload: asJson({
            ...payloadOf(card),
            lastWithdraw: providerResult,
            lastWithdrawTxId: pendingTx.id,
          }),
        },
      });

      await prisma.transaction.update({
        where: { id: pendingTx.id },
        data: {
          providerRef: pagoTxId ?? providerRef,
          metadata: asJson({
            kind: "card_withdraw",
            cardId: card.id,
            providerCardId: card.providerCardId,
            amountUsd: amount,
            settleCurrency: "NGN",
            awaitingWebhook: live,
            pagoTxId,
            walletTxId,
            providerStatus,
            raw: providerResult,
          }),
        },
      });

      // Simulated (or already-failed path): settle NGN now. Live waits for Pagocards webhook.
      if (!live || providerStatus === "failed" || providerStatus === "fail") {
        if (providerStatus === "failed" || providerStatus === "fail") {
          await this.failWithdraw(pendingTx.id, amount, card.id, "Provider rejected withdrawal");
          throw new AppError("Card withdrawal failed at Pagocards", 502);
        }
        const settled = await this.settleWithdrawToNgn({
          transactionId: pendingTx.id,
          eventId: `sim_${pendingTx.id}`,
        });
        if (!settled) throw new AppError("Could not settle simulated withdraw");
        return {
          transaction: settled.transaction,
          card: toPublicCard(updated),
          status: "SUCCESS",
          ngnAmount: settled.ngnAmount,
          rateApplied: settled.rateApplied,
          providerResult,
        };
      }

      return {
        transaction: await prisma.transaction.findUniqueOrThrow({ where: { id: pendingTx.id } }),
        card: toPublicCard(updated),
        status: "PROCESSING",
        message: "Withdrawal submitted. NGN will credit after Pagocards confirms via webhook.",
        providerResult,
      };
    } catch (error) {
      const stillPending = await prisma.transaction.findUnique({ where: { id: pendingTx.id } });
      if (stillPending?.status === "PROCESSING") {
        await prisma.transaction.update({
          where: { id: pendingTx.id },
          data: { status: "FAILED", description: `Withdraw failed: ${error instanceof Error ? error.message : "error"}` },
        });
      }
      throw error;
    }
  }

  private async failWithdraw(transactionId: string, amountUsd: number, cardId: string, reason: string) {
    await prisma.transaction.update({
      where: { id: transactionId },
      data: { status: "FAILED", description: reason },
    });
    await prisma.card.update({
      where: { id: cardId },
      data: { balance: { increment: amountUsd } },
    });
  }

  /**
   * Credit user NGN after Pagocards confirms the card withdraw (webhook or simulated settle).
   * Idempotent on eventId / already-SUCCESS transaction.
   */
  async settleWithdrawToNgn(input: {
    transactionId?: string;
    providerCardId?: string;
    pagoTxId?: string;
    eventId?: string;
    amountUsd?: number;
  }) {
    const settleRef = input.eventId ?? input.pagoTxId;
    if (settleRef) {
      const alreadyCredited = await prisma.transaction.findFirst({
        where: {
          type: "CARD_WITHDRAW",
          status: "SUCCESS",
          currency: "NGN",
          providerRef: settleRef,
        },
      });
      if (alreadyCredited) {
        const meta = asRecord(alreadyCredited.metadata);
        return {
          transaction: alreadyCredited,
          ngnAmount: Number(meta.ngnAmount ?? alreadyCredited.amount),
          rateApplied: Number(meta.rateApplied ?? 0),
        };
      }
    }

    const pending = await this.findPendingWithdraw(input);
    if (!pending) return null;
    if (pending.status === "SUCCESS") {
      const meta = asRecord(pending.metadata);
      return {
        transaction: pending,
        ngnAmount: Number(meta.ngnAmount ?? 0),
        rateApplied: Number(meta.rateApplied ?? 0),
      };
    }
    if (pending.status !== "PROCESSING") return null;

    const meta = asRecord(pending.metadata);
    const amountUsd = Number(meta.amountUsd ?? pending.amount);
    if (!(amountUsd > 0)) throw new AppError("Invalid withdraw amount");

    const quote = await fxService.quote(pending.userId, {
      fromCurrency: "USD",
      toCurrency: "NGN",
      amount: amountUsd,
    });
    const ngnAmount = Math.round(quote.toAmount * 100) / 100;

    const creditTx = await walletService.credit({
      userId: pending.userId,
      currency: "NGN",
      amount: ngnAmount,
      type: "CARD_WITHDRAW",
      description: `Card withdraw $${amountUsd} → ₦${ngnAmount.toLocaleString("en-US")}`,
      provider: pending.provider ?? "pagocards",
      providerRef: settleRef ?? pending.providerRef ?? pending.id,
      metadata: asJson({
        kind: "card_withdraw_ngn_credit",
        sourceTransactionId: pending.id,
        amountUsd,
        ngnAmount,
        rateApplied: quote.rateApplied,
        eventId: input.eventId,
      }),
    });

    const updated = await prisma.transaction.update({
      where: { id: pending.id },
      data: {
        status: "SUCCESS",
        description: `Withdraw $${amountUsd} → ₦${ngnAmount.toLocaleString("en-US")} credited`,
        metadata: asJson({
          ...meta,
          awaitingWebhook: false,
          settledAt: new Date().toISOString(),
          ngnAmount,
          rateApplied: quote.rateApplied,
          ngnCreditTxId: creditTx.id,
          settleEventId: input.eventId,
        }),
      },
    });

    await createInboxMessage({
      userId: pending.userId,
      category: "transaction",
      title: "Card withdraw settled",
      body: `$${amountUsd} left your Visa card. ₦${ngnAmount.toLocaleString("en-US")} was added to your NGN wallet.`,
    });

    return { transaction: updated, ngnAmount, rateApplied: quote.rateApplied, creditTx };
  }

  private async findPendingWithdraw(input: {
    transactionId?: string;
    providerCardId?: string;
    pagoTxId?: string;
    amountUsd?: number;
  }) {
    if (input.transactionId) {
      return prisma.transaction.findFirst({
        where: { id: input.transactionId, type: "CARD_WITHDRAW" },
      });
    }

    if (input.pagoTxId) {
      const byRef = await prisma.transaction.findFirst({
        where: { type: "CARD_WITHDRAW", providerRef: input.pagoTxId },
        orderBy: { createdAt: "desc" },
      });
      if (byRef) return byRef;

      const funding = await prisma.cardFunding.findFirst({
        where: { direction: "WITHDRAW", providerRef: input.pagoTxId },
        include: { transaction: true },
      });
      if (funding?.transaction) return funding.transaction;
    }

    if (input.providerCardId) {
      const card = await prisma.card.findFirst({
        where: { providerCardId: input.providerCardId },
      });
      if (!card) return null;
      const candidates = await prisma.transaction.findMany({
        where: {
          userId: card.userId,
          type: "CARD_WITHDRAW",
          status: "PROCESSING",
        },
        orderBy: { createdAt: "desc" },
        take: 20,
      });
      return (
        candidates.find((t) => {
          const m = asRecord(t.metadata);
          if (m.cardId !== card.id) return false;
          if (input.amountUsd != null && Math.abs(Number(t.amount) - input.amountUsd) > 0.009) return false;
          return true;
        }) ?? null
      );
    }

    return null;
  }

  async freeze(userId: string, cardId: string) {
    const card = await this.get(userId, cardId);
    if (!card.providerCardId) throw new AppError("Card is not ready", 400, "CARD_NOT_READY");
    if (usePagocardsLive()) {
      try {
        await pagocardsClient.blockVisaCard({ card_id: card.providerCardId });
      } catch {
        throw new AppError("Could not freeze card. Try again in a moment.", 502, "CARD_FREEZE_FAILED");
      }
    }
    return prisma.card.update({ where: { id: card.id }, data: { status: "FROZEN" } });
  }

  async unfreeze(userId: string, cardId: string) {
    const card = await this.get(userId, cardId);
    if (!card.providerCardId) throw new AppError("Card is not ready", 400, "CARD_NOT_READY");
    if (usePagocardsLive()) {
      try {
        await pagocardsClient.unblockVisaCard({ card_id: card.providerCardId });
      } catch {
        throw new AppError("Could not unfreeze card. Try again in a moment.", 502, "CARD_UNFREEZE_FAILED");
      }
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
      if (!card.providerCardId) throw new AppError("Card is not ready for spend controls", 400, "CARD_NOT_READY");
      try {
        await pagocardsClient.setSpendControls({
          cardid: card.providerCardId,
          email: user.email,
          ...(input.perTxLimit != null ? { single_transaction: String(input.perTxLimit) } : {}),
          ...(input.dailyLimit != null ? { daily: String(input.dailyLimit) } : {}),
          ...(input.monthlyLimit != null ? { monthly: String(input.monthlyLimit) } : {}),
        });
      } catch {
        throw new AppError(
          "Could not update card limits. Try again or contact support.",
          502,
          "CARD_LIMITS",
        );
      }
    }

    const updated = await prisma.card.update({
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
    const spentMap = await spentThisMonthByCardIds([updated.id]);
    return toPublicCard(updated, spentMap.get(updated.id) ?? 0);
  }

  async terminate(userId: string, cardId: string) {
    const card = await this.get(userId, cardId);
    if (usePagocardsLive() && card.providerCardId) {
      await pagocardsClient.terminateCard({ card_id: card.providerCardId });
    }
    return prisma.card.update({ where: { id: card.id }, data: { status: "TERMINATED" } });
  }

  async statements(userId: string, cardId: string) {
    // Do not call syncing `get()` here — Pagocards retries would delay / fail the activity feed.
    const card = await prisma.card.findFirst({ where: { id: cardId, userId } });
    if (!card) throw new NotFoundError("Card not found");

    const [fundings, authorizations, walletTxs] = await Promise.all([
      prisma.cardFunding.findMany({
        where: { cardId },
        include: { transaction: true },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      prisma.cardAuthorization.findMany({
        where: card.last4
          ? { OR: [{ cardId }, { last4: card.last4 }] }
          : { cardId },
        orderBy: { at: "desc" },
        take: 50,
      }),
      prisma.transaction.findMany({
        where: {
          userId,
          type: { in: ["CARD_FUND", "CARD_WITHDRAW", "FEE", "ADJUSTMENT"] },
          OR: [
            ...(card.providerCardId ? [{ providerRef: card.providerCardId }] : []),
            { metadata: { path: ["cardId"], equals: cardId } },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    ]);

    const fundingRows = fundings.map((f) => ({
      id: f.id,
      kind: f.direction === "WITHDRAW" ? "withdraw" : "fund",
      amount: Number(f.amount),
      currency: "USD",
      merchant: f.direction === "WITHDRAW" ? "Card withdraw" : "Card top-up",
      status: String(f.transaction?.status ?? "SUCCESS").toLowerCase(),
      createdAt: f.createdAt,
      transactionId: f.transactionId,
    }));

    const fundingTxIds = new Set(fundingRows.map((r) => r.transactionId).filter(Boolean));

    const walletRows = walletTxs
      .filter((t) => !fundingTxIds.has(t.id))
      .map((t) => {
        const meta = (t.metadata && typeof t.metadata === "object" ? t.metadata : {}) as Record<string, unknown>;
        const kind =
          t.type === "CARD_WITHDRAW"
            ? "withdraw"
            : t.type === "CARD_FUND"
              ? "fund"
              : "fee";
        const amount =
          kind === "fund" && typeof meta.cardAmount === "number"
            ? meta.cardAmount
            : Number(t.amount);
        return {
          id: t.id,
          kind,
          amount,
          currency: String(t.currency || "USD"),
          merchant:
            kind === "withdraw"
              ? "Card withdraw"
              : kind === "fund"
                ? "Card top-up"
                : t.description?.trim() || "Card fee",
          status: String(t.status).toLowerCase(),
          createdAt: t.createdAt,
          transactionId: t.id as string | null,
        };
      });

    const authRows = authorizations.map((a) => ({
      id: a.id,
      kind: "spend",
      amount: Number(a.amount),
      currency: a.currency || "USD",
      merchant: a.merchant || "Card spend",
      status: String(a.decision).toLowerCase(),
      createdAt: a.at,
      transactionId: null as string | null,
    }));

    return [...fundingRows, ...walletRows, ...authRows]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 80);
  }

  /**
   * Persist a merchant authorisation from a card provider webhook (Strowallet / Pagocards).
   * Idempotent on `reference` / `id` → networkRef. Skips events that cannot be linked to a Card.
   */
  async recordAuthorizationFromWebhook(payload: Record<string, unknown>) {
    const providerCardId =
      pickStr(payload.cardId) ??
      pickStr(payload.card_Id) ??
      pickStr(payload.card_id) ??
      pickStr(payload.cardid);
    if (!providerCardId) return null;

    const networkRef =
      pickStr(payload.reference) ??
      pickStr(payload.id) ??
      pickStr(payload["transaction.created"]) ??
      pickStr(payload["authorization.request"]);

    if (networkRef) {
      const existing = await prisma.cardAuthorization.findFirst({ where: { networkRef } });
      if (existing) return existing;
    }

    const card = await prisma.card.findFirst({
      where: { OR: [{ providerCardId }, { id: providerCardId }] },
      include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
    });
    if (!card) return null;

    const amount = pickNum(payload.amount) ?? pickNum(payload.merchantAmount) ?? 0;
    const currency = (pickStr(payload.currency) ?? card.currency ?? "USD").toUpperCase();
    const status = (pickStr(payload.status) ?? "").toLowerCase();
    const type = (pickStr(payload.type) ?? "").toLowerCase();
    const reason = pickStr(payload.reason) ?? pickStr(payload.narrative) ?? "";

    let decision = "approved";
    if (type.includes("declined") || status === "failed" || status === "declined" || /decline|deny|reject/i.test(reason)) {
      decision = "declined";
    } else if (type.includes("refund") || status === "reversed" || status === "refunded") {
      decision = "reversed";
    } else if (status === "pending" || status === "processing") {
      decision = "pending";
    }

    const merchant =
      pickStr(payload.merchant) ??
      (typeof payload.merchant === "object" && payload.merchant
        ? pickStr((payload.merchant as Record<string, unknown>).name)
        : undefined) ??
      pickStr(payload.narrative) ??
      "Card merchant";

    const mcc =
      pickStr(payload.mcc) ??
      (typeof payload.merchant === "object" && payload.merchant
        ? pickStr((payload.merchant as Record<string, unknown>).category)
        : undefined) ??
      "";

    const country =
      pickStr(payload.country) ??
      (typeof payload.merchant === "object" && payload.merchant
        ? pickStr((payload.merchant as Record<string, unknown>).country)
        : undefined) ??
      "";

    const declineCode =
      decision === "declined"
        ? (reason.match(/\b(51|05|57|61|65|91|1A|62)\b/i)?.[1]?.toUpperCase() ?? "05")
        : null;

    const atRaw = pickStr(payload.date) ?? pickStr(payload.createdAt);
    const at = atRaw ? new Date(atRaw) : new Date();
    const name = [card.user.firstName, card.user.lastName].filter(Boolean).join(" ").trim() || card.user.email;

    return prisma.cardAuthorization.create({
      data: {
        cardId: card.id,
        userId: card.userId,
        last4: card.last4 ?? "",
        customerName: name,
        merchant,
        mcc,
        mccLabel: mcc || "—",
        country,
        amount,
        currency,
        billingAmount: amount,
        fxRate: 1,
        decision,
        declineCode,
        threeDs: false,
        networkRef: networkRef ?? undefined,
        latencyMs: 0,
        riskScore: decision === "declined" ? 55 : 15,
        at: Number.isNaN(at.getTime()) ? new Date() : at,
      },
    });
  }
}

function pickStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function pickNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

export const cardsService = new CardsService();
