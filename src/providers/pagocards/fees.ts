/**
 * Pagocards 493-BIN Visa (`us_493_visa_bin`) published fees.
 * Source: https://pagocards.com/fees (XXX-BIN SERIES → 493-BIN)
 * Create/fund mins: https://pagocards.com/documentation#v1-cards-create
 */
export const PAGO_VISA = {
  /** Card issuance — 493-BIN */
  issuanceFeeUsd: 0.65,
  /**
   * Amount Pagocards loads onto a new 493-BIN card when `initial_load` is omitted.
   * Do not call POST …/fund for this amount after create — it double-loads the card.
   */
  defaultInitialLoadUsd: 5,
  /**
   * Minimum top-up via POST /api/v1/cards/{id}/fund.
   * (Create-time `initial_load`, if used, has a separate $10 minimum.)
   */
  minFundUsd: 5,
  /**
   * Card must retain at least this after withdraw (Pagocards 493-BIN rule).
   * e.g. $7 balance → max withdraw $2.
   */
  minRetainBalanceUsd: 5,
  /** @deprecated use minFundUsd — kept for mobile compatibility */
  minInitialFundUsd: 5,
  /** Flat portion of every card load — 493-BIN */
  fundFeeFlatUsd: 0.15,
  /** Percent portion of every card load (0.75% → 0.0075) */
  fundFeeRate: 0.0075,
} as const;

/** Load fee Pagocards takes from the merchant wallet when funding `amount`. */
export function pagoVisaFundFeeUsd(amount: number): number {
  const fee = PAGO_VISA.fundFeeFlatUsd + amount * PAGO_VISA.fundFeeRate;
  return Math.round(fee * 100) / 100;
}

/** Total debited from the user wallet so `amount` reaches the card after Pagocards fees. */
export function pagoVisaFundDebitUsd(amount: number): number {
  return Math.round((amount + pagoVisaFundFeeUsd(amount)) * 100) / 100;
}

/**
 * Extra amount to POST …/fund so the card ends at `desiredOnCardUsd`
 * after Pagocards' default create-time load.
 */
export function pagoVisaExtraFundUsd(desiredOnCardUsd: number): number {
  const extra = Math.round((desiredOnCardUsd - PAGO_VISA.defaultInitialLoadUsd) * 100) / 100;
  return extra > 0 ? extra : 0;
}
