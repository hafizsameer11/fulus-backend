/**
 * Pagocards Visa 493 BIN (`us_493_visa_bin`) published fees.
 * Source of truth: https://pagocards.com/fees (VisaCard)
 * Docs also note initial loading and fund fees: https://pagocards.com/documentation
 *
 * Note: documentation text sometimes cites fund fee as "$1 + 1%"; the public
 * fees page and Visa launch pricing list "$1 + 2%". We follow the fees page.
 */
export const PAGO_VISA = {
  /** Charged by Pagocards on each new Visa card */
  issuanceFeeUsd: 4,
  /** Minimum amount that must land on the card at first fund (our BIN) */
  minInitialFundUsd: 5,
  /** Flat portion of every card load */
  fundFeeFlatUsd: 1,
  /** Percent portion of every card load (2% → 0.02) */
  fundFeeRate: 0.02,
} as const;

/** Load fee Pagocards takes from the merchant visa wallet when funding `amount`. */
export function pagoVisaFundFeeUsd(amount: number): number {
  const fee = PAGO_VISA.fundFeeFlatUsd + amount * PAGO_VISA.fundFeeRate;
  return Math.round(fee * 100) / 100;
}

/** Total debited from the user wallet so `amount` reaches the card after Pagocards fees. */
export function pagoVisaFundDebitUsd(amount: number): number {
  return Math.round((amount + pagoVisaFundFeeUsd(amount)) * 100) / 100;
}
