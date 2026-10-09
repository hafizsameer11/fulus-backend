/**
 * Pagocards 404-BIN Visa (`us_404_visa_bin`) published fee defaults.
 * Source: https://pagocards.com/fees (XXX-BIN SERIES → 404-BIN)
 * Create/fund mins: https://pagocards.com/documentation#v1-cards-create
 *
 * Live values are overridden by CardProgram (admin-editable) when present.
 */
import { prisma } from "../../lib/prisma.js";

export const PAGO_VISA = {
  /** Card issuance — 404-BIN */
  issuanceFeeUsd: 0.65,
  /**
   * Amount Pagocards loads onto a new 404-BIN card when `initial_load` is omitted.
   * Do not call POST …/fund for this amount after create — it double-loads the card.
   */
  defaultInitialLoadUsd: 5,
  /**
   * Minimum top-up via POST /api/v1/cards/{id}/fund.
   * (Create-time `initial_load`, if used, has a separate $10 minimum.)
   */
  minFundUsd: 5,
  /**
   * Card must retain at least this after withdraw (Pagocards 404-BIN rule).
   * e.g. $7 balance → max withdraw $2.
   */
  minRetainBalanceUsd: 5,
  /** @deprecated use minFundUsd — kept for mobile compatibility */
  minInitialFundUsd: 5,
  /** Flat portion of every card load — 404-BIN */
  fundFeeFlatUsd: 0.15,
  /** Percent portion of every card load (0.75% → 0.0075) */
  fundFeeRate: 0.0075,
} as const;

export type CardFeeSchedule = {
  issuanceFeeUsd: number;
  monthlyFeeUsd: number;
  fxMarkupPct: number;
  fundFeeFlatUsd: number;
  fundFeeRate: number;
  minFundUsd: number;
  defaultInitialLoadUsd: number;
  minRetainBalanceUsd: number;
};

let feesCache: { at: number; value: CardFeeSchedule } | null = null;
const FEES_TTL_MS = 15_000;

function num(v: unknown, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Admin-configured fees from the live Pagocards CardProgram, else Pagocards defaults. */
export async function resolveCardFees(): Promise<CardFeeSchedule> {
  if (feesCache && Date.now() - feesCache.at < FEES_TTL_MS) return feesCache.value;
  const row = await prisma.cardProgram.findFirst({
    where: { processor: { in: ["Pagocards", "pagocards"] }, status: { not: "paused" } },
    orderBy: { updatedAt: "desc" },
  });
  const value: CardFeeSchedule = {
    issuanceFeeUsd: num(row?.issuanceFeeUsd, PAGO_VISA.issuanceFeeUsd),
    monthlyFeeUsd: num(row?.monthlyFeeUsd, 0),
    fxMarkupPct: num(row?.fxMarkupPct, 0),
    fundFeeFlatUsd: num(row?.fundFeeFlatUsd, PAGO_VISA.fundFeeFlatUsd),
    fundFeeRate: num(row?.fundFeeRate, PAGO_VISA.fundFeeRate),
    minFundUsd: num(row?.minFundUsd, PAGO_VISA.minFundUsd),
    defaultInitialLoadUsd: num(row?.defaultInitialLoadUsd, PAGO_VISA.defaultInitialLoadUsd),
    minRetainBalanceUsd: num(row?.minRetainBalanceUsd, PAGO_VISA.minRetainBalanceUsd),
  };
  feesCache = { at: Date.now(), value };
  return value;
}

export function invalidateCardFeesCache() {
  feesCache = null;
}

/** Load fee for funding `amount` onto a card. */
export function cardFundFeeUsd(amount: number, fees: Pick<CardFeeSchedule, "fundFeeFlatUsd" | "fundFeeRate"> = PAGO_VISA) {
  const fee = fees.fundFeeFlatUsd + amount * fees.fundFeeRate;
  return Math.round(fee * 100) / 100;
}

/** @deprecated prefer cardFundFeeUsd with resolveCardFees() */
export function pagoVisaFundFeeUsd(amount: number): number {
  return cardFundFeeUsd(amount, PAGO_VISA);
}

/** Total debited from the user wallet so `amount` reaches the card after fees. */
export function cardFundDebitUsd(amount: number, fees: Pick<CardFeeSchedule, "fundFeeFlatUsd" | "fundFeeRate"> = PAGO_VISA) {
  return Math.round((amount + cardFundFeeUsd(amount, fees)) * 100) / 100;
}

/** @deprecated prefer cardFundDebitUsd with resolveCardFees() */
export function pagoVisaFundDebitUsd(amount: number): number {
  return cardFundDebitUsd(amount, PAGO_VISA);
}

/**
 * Extra amount to POST …/fund so the card ends at `desiredOnCardUsd`
 * after Pagocards' default create-time load.
 */
export function cardExtraFundUsd(desiredOnCardUsd: number, defaultInitialLoadUsd: number = Number(PAGO_VISA.defaultInitialLoadUsd)) {
  const extra = Math.round((desiredOnCardUsd - defaultInitialLoadUsd) * 100) / 100;
  return extra > 0 ? extra : 0;
}

/** @deprecated prefer cardExtraFundUsd with resolveCardFees() */
export function pagoVisaExtraFundUsd(desiredOnCardUsd: number): number {
  return cardExtraFundUsd(desiredOnCardUsd, PAGO_VISA.defaultInitialLoadUsd);
}
