import { z } from "zod";
import { prisma } from "../../../lib/prisma.js";
import { AppError } from "../../../lib/errors.js";

const CONFIG_PREFIX = "crypto.asset.";

export const cryptoAssetConfigSchema = z.object({
  code: z.string().min(2).max(16),
  enabled: z.boolean().optional(),
  buyEnabled: z.boolean().optional(),
  sellEnabled: z.boolean().optional(),
  sendEnabled: z.boolean().optional(),
  /** Basis points above Busha mid when the customer buys (100 = 1%). */
  buySpreadBps: z.number().int().min(0).max(5000).optional(),
  /** Basis points below Busha mid when the customer sells. */
  sellSpreadBps: z.number().int().min(0).max(5000).optional(),
  minTradeUsd: z.number().min(0).optional(),
  maxTradeUsd: z.number().min(0).optional(),
});

export type CryptoAssetConfig = {
  code: string;
  enabled: boolean;
  buyEnabled: boolean;
  sellEnabled: boolean;
  sendEnabled: boolean;
  buySpreadBps: number;
  sellSpreadBps: number;
  minTradeUsd: number;
  maxTradeUsd: number;
  updatedAt?: string;
};

const DEFAULTS: Omit<CryptoAssetConfig, "code" | "updatedAt"> = {
  enabled: true,
  buyEnabled: true,
  sellEnabled: true,
  sendEnabled: true,
  buySpreadBps: 100,
  sellSpreadBps: 100,
  minTradeUsd: 2,
  maxTradeUsd: 100_000,
};

/** Demo-aligned defaults for known assets when no PlatformConfig row exists. */
const SEED: Record<string, Partial<CryptoAssetConfig>> = {
  BTC: { buySpreadBps: 120, sellSpreadBps: 140, minTradeUsd: 5, maxTradeUsd: 50_000 },
  ETH: { buySpreadBps: 130, sellSpreadBps: 150, minTradeUsd: 5, maxTradeUsd: 40_000 },
  USDT: { buySpreadBps: 60, sellSpreadBps: 70, minTradeUsd: 2, maxTradeUsd: 100_000 },
  USDC: { buySpreadBps: 60, sellSpreadBps: 70, minTradeUsd: 2, maxTradeUsd: 100_000 },
  SOL: { buySpreadBps: 160, sellSpreadBps: 180, minTradeUsd: 5, maxTradeUsd: 25_000 },
  BNB: { buySpreadBps: 150, sellSpreadBps: 170, minTradeUsd: 5, maxTradeUsd: 20_000 },
  XRP: { buySpreadBps: 180, sellSpreadBps: 200, minTradeUsd: 2, maxTradeUsd: 10_000, sendEnabled: false },
  TRX: { buySpreadBps: 190, sellSpreadBps: 210, minTradeUsd: 2, maxTradeUsd: 8_000 },
  DOGE: { enabled: false, buyEnabled: false, buySpreadBps: 220, sellSpreadBps: 240, minTradeUsd: 2, maxTradeUsd: 5_000, sendEnabled: false },
  MATIC: { enabled: false, buyEnabled: false, sellEnabled: false, sendEnabled: false, buySpreadBps: 200, sellSpreadBps: 220 },
};

function configKey(code: string) {
  return `${CONFIG_PREFIX}${code.toUpperCase()}`;
}

function mergeDefaults(code: string, partial?: Partial<CryptoAssetConfig>): CryptoAssetConfig {
  const upper = code.toUpperCase();
  const seed = SEED[upper] ?? {};
  return {
    ...DEFAULTS,
    ...seed,
    ...partial,
    code: upper,
  };
}

export function buyFactor(bps: number) {
  return 1 + Math.max(0, bps) / 10_000;
}

export function sellFactor(bps: number) {
  return 1 - Math.max(0, Math.min(bps, 9_999)) / 10_000;
}

/** BUY: same fiat → less crypto. All-in rate = bushaMid * buyFactor. */
export function applyBuySpread(bushaReceive: number, bps: number) {
  const factor = buyFactor(bps);
  const customerReceive = bushaReceive / factor;
  return {
    factor,
    customerReceive,
    bushaReceive,
    /** Fraction of user fiat kept as desk margin. */
    marginFraction: 1 - 1 / factor,
  };
}

/** SELL: same crypto → less fiat. All-in rate = bushaMid * sellFactor. */
export function applySellSpread(bushaFiatOut: number, bps: number) {
  const factor = sellFactor(bps);
  const customerReceive = bushaFiatOut * factor;
  return {
    factor,
    customerReceive,
    bushaFiatOut,
    margin: bushaFiatOut - customerReceive,
  };
}

export class CryptoAssetConfigService {
  async get(code: string): Promise<CryptoAssetConfig> {
    const key = configKey(code);
    const row = await prisma.platformConfig.findUnique({ where: { key } });
    if (!row?.value) return mergeDefaults(code);
    try {
      const parsed = JSON.parse(row.value) as Partial<CryptoAssetConfig>;
      return mergeDefaults(code, { ...parsed, updatedAt: row.updatedAt.toISOString() });
    } catch {
      return mergeDefaults(code);
    }
  }

  async list(codes?: string[]): Promise<CryptoAssetConfig[]> {
    const rows = await prisma.platformConfig.findMany({
      where: { key: { startsWith: CONFIG_PREFIX } },
    });
    const byCode = new Map<string, CryptoAssetConfig>();
    for (const row of rows) {
      const code = row.key.slice(CONFIG_PREFIX.length).toUpperCase();
      if (!code) continue;
      try {
        const parsed = JSON.parse(row.value) as Partial<CryptoAssetConfig>;
        byCode.set(code, mergeDefaults(code, { ...parsed, updatedAt: row.updatedAt.toISOString() }));
      } catch {
        byCode.set(code, mergeDefaults(code, { updatedAt: row.updatedAt.toISOString() }));
      }
    }
    const wanted = codes?.map((c) => c.toUpperCase()) ?? [
      ...new Set([...Object.keys(SEED), ...byCode.keys()]),
    ];
    return wanted.map((code) => byCode.get(code) ?? mergeDefaults(code));
  }

  async upsert(input: z.infer<typeof cryptoAssetConfigSchema>): Promise<CryptoAssetConfig> {
    const parsed = cryptoAssetConfigSchema.parse(input);
    const code = parsed.code.toUpperCase();
    const existing = await this.get(code);
    const next: CryptoAssetConfig = {
      ...existing,
      ...Object.fromEntries(
        Object.entries(parsed).filter(([, v]) => v !== undefined),
      ),
      code,
    };
    if (next.maxTradeUsd < next.minTradeUsd) {
      throw new AppError("maxTradeUsd must be >= minTradeUsd", 400, "BAD_REQUEST");
    }
    const { updatedAt: _u, ...store } = next;
    const row = await prisma.platformConfig.upsert({
      where: { key: configKey(code) },
      create: { key: configKey(code), value: JSON.stringify(store) },
      update: { value: JSON.stringify(store) },
    });
    return { ...next, updatedAt: row.updatedAt.toISOString() };
  }

  async assertTradeAllowed(code: string, side: "BUY" | "SELL", notionalUsd?: number) {
    const cfg = await this.get(code);
    if (!cfg.enabled) {
      throw new AppError(`${code} is not listed for trading`, 400, "ASSET_DELISTED");
    }
    if (side === "BUY" && !cfg.buyEnabled) {
      throw new AppError(`Buying ${code} is paused`, 400, "BUY_DISABLED");
    }
    if (side === "SELL" && !cfg.sellEnabled) {
      throw new AppError(`Selling ${code} is paused`, 400, "SELL_DISABLED");
    }
    if (notionalUsd != null && Number.isFinite(notionalUsd)) {
      if (notionalUsd < cfg.minTradeUsd) {
        throw new AppError(`Minimum trade is $${cfg.minTradeUsd}`, 400, "BELOW_MIN_TRADE");
      }
      if (notionalUsd > cfg.maxTradeUsd) {
        throw new AppError(`Maximum trade is $${cfg.maxTradeUsd}`, 400, "ABOVE_MAX_TRADE");
      }
    }
    return cfg;
  }
}

export const cryptoAssetConfigService = new CryptoAssetConfigService();
