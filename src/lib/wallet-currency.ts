import { WalletCurrency } from "@prisma/client";

const FIAT = new Set<string>([
  WalletCurrency.NGN,
  WalletCurrency.USD,
  WalletCurrency.SAR,
]);

const ALL = new Set<string>(Object.values(WalletCurrency));

export function isWalletCurrency(value: string): value is WalletCurrency {
  return ALL.has(value.toUpperCase());
}

export function isFiatCurrency(value: string): boolean {
  return FIAT.has(value.toUpperCase());
}

/** Ledgerable crypto wallets (everything in WalletCurrency except fiat). */
export function isCryptoWalletCurrency(value: string): value is WalletCurrency {
  const c = value.toUpperCase();
  return ALL.has(c) && !FIAT.has(c);
}

export function asWalletCurrency(value: string): WalletCurrency {
  const c = value.toUpperCase();
  if (!ALL.has(c)) {
    throw new Error(`Unsupported wallet currency: ${value}`);
  }
  return c as WalletCurrency;
}

export const CRYPTO_WALLET_CURRENCIES: WalletCurrency[] = Object.values(WalletCurrency).filter(
  (c) => !FIAT.has(c),
);
