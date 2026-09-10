import { env } from "../config/env.js";

/**
 * When true (default in development, or SIMULATE_PROVIDERS=1),
 * provider calls are faked locally so the app can demo end-to-end
 * without Pagocards / Busha / Prembly / Strowallet / eSIM Go keys.
 */
export function simulateProviders(): boolean {
  if (process.env.SIMULATE_PROVIDERS === "0" || process.env.SIMULATE_PROVIDERS === "false") {
    return false;
  }
  if (process.env.SIMULATE_PROVIDERS === "1" || process.env.SIMULATE_PROVIDERS === "true") {
    return true;
  }
  return env.NODE_ENV !== "production";
}

export function hasPagocardsKeys() {
  return Boolean(env.PAGOCARDS_PUBLIC_KEY && env.PAGOCARDS_SECRET_KEY);
}

export function hasBushaKeys() {
  return Boolean(env.BUSHA_SECRET_KEY);
}

export function hasPremblyKeys() {
  return Boolean(env.PREMBLY_API_KEY);
}

export function hasStrowalletKeys() {
  return Boolean(env.STROWALLET_PUBLIC_KEY || env.STROWALLET_SECRET_KEY);
}

export function hasEsimGoKeys() {
  return Boolean(env.ESIM_GO_API_KEY);
}

export function usePagocardsLive() {
  return hasPagocardsKeys() && !simulateProviders();
}

export function useBushaLive() {
  return hasBushaKeys() && !simulateProviders();
}

export function usePremblyLive() {
  return hasPremblyKeys() && !simulateProviders();
}

export function useStrowalletLive() {
  return hasStrowalletKeys() && !simulateProviders();
}

export function useEsimGoLive() {
  return hasEsimGoKeys() && !simulateProviders();
}

export function simRef(prefix: string) {
  return `${prefix}_SIM_${Date.now().toString(36).toUpperCase()}`;
}

export function simLast4() {
  return String(1000 + Math.floor(Math.random() * 9000));
}

export function simIccid() {
  return `89${Date.now().toString().slice(-12)}${Math.floor(Math.random() * 1e6)
    .toString()
    .padStart(6, "0")}`;
}

export function simCryptoAddress(currency: string, network: string, userId: string) {
  const seed = `${userId}:${currency}:${network}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h << 5) - h + seed.charCodeAt(i);
  const hex = Math.abs(h).toString(16).padStart(8, "0");
  if (currency === "BTC" || network.toLowerCase().includes("btc")) {
    return `bc1qsim${hex}${hex.slice(0, 8)}`;
  }
  if (currency === "ETH" || network.toLowerCase().includes("erc")) {
    return `0xsim${hex}${hex}${hex.slice(0, 8)}`;
  }
  return `TSim${hex}${hex.toUpperCase()}`;
}
