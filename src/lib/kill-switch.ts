import { prisma } from "./prisma.js";
import { AppError } from "./errors.js";

export const KILL_SWITCH_KEYS = {
  TRANSFERS: "kill.transfers",
  CRYPTO_SEND: "kill.crypto_send",
  CARDS_FUND: "kill.cards_fund",
  DEPOSITS: "kill.deposits",
} as const;

const cache = new Map<string, { value: boolean; expiresAt: number }>();
const CACHE_MS = 5_000;

async function readFlag(key: string): Promise<boolean> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;

  const row = await prisma.platformConfig.findUnique({ where: { key } });
  const value = row?.value === "1" || row?.value === "true";
  cache.set(key, { value, expiresAt: now + CACHE_MS });
  return value;
}

export async function assertKillSwitchOff(key: string, message: string) {
  if (await readFlag(key)) {
    throw new AppError(message, 503, "SERVICE_DISABLED");
  }
}

export function invalidateKillSwitchCache() {
  cache.clear();
}
