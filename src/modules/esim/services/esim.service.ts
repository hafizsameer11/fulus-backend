import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { AppError, NotFoundError } from "../../../lib/errors.js";
import { esimGoClient } from "../../../providers/esim-go/client.js";
import { walletService } from "../../wallet/services/wallet.service.js";
import { simIccid, simRef, useEsimGoLive } from "../../../lib/simulate.js";
import { createInboxMessage } from "../../../lib/inbox.js";

export const purchaseSchema = z.object({
  bundleName: z.string().min(1),
  amount: z.number().positive(),
  currency: z.enum(["NGN", "USD"]).default("USD"),
  label: z.string().optional(),
  quantity: z.number().int().positive().default(1),
});

export const topupSchema = z.object({
  bundleName: z.string().min(1),
  amount: z.number().positive(),
  currency: z.enum(["NGN", "USD"]).default("USD"),
  dataMb: z.number().int().positive().optional(),
});

export const patchEsimSchema = z.object({
  label: z.string().min(1).max(60).optional(),
  status: z.enum(["ORDERED", "READY", "INSTALLED", "DEPLETED", "EXPIRED", "FAILED"]).optional(),
});

/** Normalized catalogue row shared by live + simulated modes (matches eSIM Go fields). */
export type CatalogueCountry = {
  iso: string;
  name: string;
  region: string;
  networks: Array<{ name: string; brandName?: string; speeds?: string[] }>;
};

export type CatalogueBundle = {
  name: string;
  description: string;
  dataMb: number;
  days: number;
  unlimited: boolean;
  price: number;
  currency: string;
  groups: string[];
  speed: string[];
  autostart: boolean;
  countries: CatalogueCountry[];
};

export type CatalogueDestination = {
  key: string;
  name: string;
  short: string;
  iso?: string;
  emblem?: "asia" | "africa" | "global";
  regionLabel: string;
  from: number;
  countries: number;
  countryList: Array<{ iso: string; name: string }>;
  planCount: number;
  accent: string;
};

const SIM_CATALOGUE_RAW: Array<
  Omit<CatalogueBundle, "currency" | "groups" | "speed" | "autostart" | "countries"> & {
    countries: Array<{ iso: string; name: string; region: string }>;
  }
> = [
  {
    name: "esim_1GB_7D_NG_V2",
    description: "Nigeria 1GB 7 Days",
    dataMb: 1024,
    days: 7,
    unlimited: false,
    price: 3,
    countries: [{ iso: "NG", name: "Nigeria", region: "Africa" }],
  },
  {
    name: "esim_3GB_15D_NG_V2",
    description: "Nigeria 3GB 15 Days",
    dataMb: 3072,
    days: 15,
    unlimited: false,
    price: 7.2,
    countries: [{ iso: "NG", name: "Nigeria", region: "Africa" }],
  },
  {
    name: "esim_5GB_30D_NG_V2",
    description: "Nigeria 5GB 30 Days",
    dataMb: 5120,
    days: 30,
    unlimited: false,
    price: 10.8,
    countries: [{ iso: "NG", name: "Nigeria", region: "Africa" }],
  },
  {
    name: "esim_1GB_7D_US_V2",
    description: "USA 1GB 7 Days",
    dataMb: 1024,
    days: 7,
    unlimited: false,
    price: 5.5,
    countries: [{ iso: "US", name: "United States", region: "North America" }],
  },
  {
    name: "esim_5GB_30D_US_V2",
    description: "USA 5GB 30 Days",
    dataMb: 5120,
    days: 30,
    unlimited: false,
    price: 16,
    countries: [{ iso: "US", name: "United States", region: "North America" }],
  },
  {
    name: "esim_1GB_7D_GB_V2",
    description: "UK 1GB 7 Days",
    dataMb: 1024,
    days: 7,
    unlimited: false,
    price: 5,
    countries: [{ iso: "GB", name: "United Kingdom", region: "Europe" }],
  },
  {
    name: "esim_3GB_15D_SA_V2",
    description: "Saudi Arabia 3GB 15 Days",
    dataMb: 3072,
    days: 15,
    unlimited: false,
    price: 7.5,
    countries: [{ iso: "SA", name: "Saudi Arabia", region: "Middle East" }],
  },
  {
    name: "esim_1GB_7D_AE_V2",
    description: "UAE 1GB 7 Days",
    dataMb: 1024,
    days: 7,
    unlimited: false,
    price: 4,
    countries: [{ iso: "AE", name: "United Arab Emirates", region: "Middle East" }],
  },
  {
    name: "esim_1GB_7D_TR_V2",
    description: "Türkiye 1GB 7 Days",
    dataMb: 1024,
    days: 7,
    unlimited: false,
    price: 4,
    countries: [{ iso: "TR", name: "Türkiye", region: "Europe" }],
  },
  {
    name: "esim_1GB_7D_EG_V2",
    description: "Egypt 1GB 7 Days",
    dataMb: 1024,
    days: 7,
    unlimited: false,
    price: 4,
    countries: [{ iso: "EG", name: "Egypt", region: "Africa" }],
  },
  {
    name: "esim_1GB_7D_ZA_V2",
    description: "South Africa 1GB 7 Days",
    dataMb: 1024,
    days: 7,
    unlimited: false,
    price: 5,
    countries: [{ iso: "ZA", name: "South Africa", region: "Africa" }],
  },
  {
    name: "esim_1GB_7D_EU_V2",
    description: "Europe 1GB 7 Days",
    dataMb: 1024,
    days: 7,
    unlimited: false,
    price: 4.5,
    countries: [
      { iso: "FR", name: "France", region: "Europe" },
      { iso: "DE", name: "Germany", region: "Europe" },
      { iso: "ES", name: "Spain", region: "Europe" },
      { iso: "IT", name: "Italy", region: "Europe" },
    ],
  },
  {
    name: "esim_3GB_15D_EU_V2",
    description: "Europe 3GB 15 Days",
    dataMb: 3072,
    days: 15,
    unlimited: false,
    price: 9.9,
    countries: [
      { iso: "FR", name: "France", region: "Europe" },
      { iso: "DE", name: "Germany", region: "Europe" },
      { iso: "ES", name: "Spain", region: "Europe" },
      { iso: "IT", name: "Italy", region: "Europe" },
    ],
  },
  {
    name: "esim_1GB_7D_AS_V2",
    description: "Asia 1GB 7 Days",
    dataMb: 1024,
    days: 7,
    unlimited: false,
    price: 8,
    countries: [
      { iso: "JP", name: "Japan", region: "Asia" },
      { iso: "SG", name: "Singapore", region: "Asia" },
      { iso: "TH", name: "Thailand", region: "Asia" },
    ],
  },
  {
    name: "esim_1GB_7D_AF_V2",
    description: "Africa 1GB 7 Days",
    dataMb: 1024,
    days: 7,
    unlimited: false,
    price: 8,
    countries: [
      { iso: "NG", name: "Nigeria", region: "Africa" },
      { iso: "KE", name: "Kenya", region: "Africa" },
      { iso: "GH", name: "Ghana", region: "Africa" },
    ],
  },
  {
    name: "esim_1GB_7D_GL_V2",
    description: "Global 1GB 7 Days",
    dataMb: 1024,
    days: 7,
    unlimited: false,
    price: 12,
    countries: [
      { iso: "US", name: "United States", region: "North America" },
      { iso: "GB", name: "United Kingdom", region: "Europe" },
      { iso: "NG", name: "Nigeria", region: "Africa" },
      { iso: "JP", name: "Japan", region: "Asia" },
    ],
  },
];

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function extractBundleRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const obj = asRecord(payload);
  if (!obj) return [];
  if (Array.isArray(obj.bundles)) return obj.bundles;
  if (Array.isArray(obj.Bundles)) return obj.Bundles;
  if (Array.isArray(obj.data)) return obj.data;
  return [];
}

function normalizeCountry(raw: unknown): CatalogueCountry | null {
  const c = asRecord(raw);
  if (!c) return null;
  const nested = asRecord(c.country);
  const iso = String(c.iso ?? nested?.iso ?? "").toUpperCase();
  if (!iso) return null;

  const networksRaw = Array.isArray(c.networks) ? c.networks : [];
  const networks = networksRaw
    .map((n) => {
      const row = asRecord(n);
      if (!row) return null;
      const name = String(row.name ?? row.brandName ?? "").trim();
      if (!name) return null;
      return {
        name,
        brandName: typeof row.brandName === "string" ? row.brandName : undefined,
        speeds: Array.isArray(row.speeds) ? row.speeds.map(String) : undefined,
      };
    })
    .filter((n): n is NonNullable<typeof n> => Boolean(n));

  return {
    iso,
    name: String(c.name ?? nested?.name ?? iso),
    region: String(c.region ?? nested?.region ?? ""),
    networks,
  };
}

function normalizeBundle(raw: unknown): CatalogueBundle | null {
  const b = asRecord(raw);
  if (!b) return null;
  const name = String(b.name ?? "").trim();
  if (!name) return null;

  const byIso = new Map<string, CatalogueCountry>();
  const pushCountry = (country: CatalogueCountry | null) => {
    if (!country) return;
    const existing = byIso.get(country.iso);
    if (!existing) {
      byIso.set(country.iso, country);
      return;
    }
    const netNames = new Set(existing.networks.map((n) => n.name));
    for (const n of country.networks) {
      if (!netNames.has(n.name)) existing.networks.push(n);
    }
  };

  if (Array.isArray(b.countries)) {
    for (const row of b.countries) pushCountry(normalizeCountry(row));
  }
  if (Array.isArray(b.countryNetworks)) {
    for (const row of b.countryNetworks) pushCountry(normalizeCountry(row));
  }
  if (Array.isArray(b.roamingEnabled)) {
    for (const row of b.roamingEnabled) {
      const c = normalizeCountry(row);
      if (c && !byIso.has(c.iso)) byIso.set(c.iso, { ...c, networks: [] });
    }
  }

  const dataMb = Number(b.dataAmount ?? b.dataMb ?? 0);
  const days = Number(b.duration ?? b.days ?? 0);
  const unlimited = Boolean(b.unlimited);
  const price = Number(b.price ?? 0);
  const groups = Array.isArray(b.groups)
    ? b.groups.map((g) => String(g)).filter(Boolean)
    : typeof b.group === "string"
      ? [b.group]
      : [];
  const speed = Array.isArray(b.speed) ? b.speed.map(String) : [];

  return {
    name,
    description: String(b.description ?? name),
    dataMb: Number.isFinite(dataMb) ? dataMb : 0,
    days: Number.isFinite(days) ? days : 0,
    unlimited,
    price: Number.isFinite(price) ? price : 0,
    currency: String(b.currency ?? "USD").toUpperCase(),
    groups,
    speed,
    autostart: Boolean(b.autostart),
    countries: [...byIso.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

const REGION_NAME_TO_KEY: Record<string, string> = {
  europe: "eu",
  asia: "as",
  africa: "af",
  global: "gl",
  worldwide: "gl",
  "north america": "na",
  "middle east": "me",
  "latin america": "latam",
  "south america": "latam",
  oceania: "oc",
  caribbean: "caribbean",
};

const ISO_ACCENT: Record<string, string> = {
  NG: "#008751",
  SA: "#006C35",
  US: "#0A3161",
  GB: "#C8102E",
  AE: "#00732F",
  TR: "#E30A17",
  EG: "#C8102E",
  ZA: "#007749",
  EU: "#003399",
  FR: "#002395",
  DE: "#000000",
  JP: "#BC002D",
  IN: "#FF9933",
};

function slugKey(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

function destinationOf(bundle: CatalogueBundle): {
  key: string;
  name: string;
  iso?: string;
  regionLabel: string;
  emblem?: "asia" | "africa" | "global";
} {
  const countries = bundle.countries;
  if (countries.length === 1) {
    const c = countries[0]!;
    return {
      key: c.iso.toLowerCase() === "gb" ? "uk" : c.iso.toLowerCase(),
      name: c.name,
      iso: c.iso.toLowerCase() === "gb" ? "gb" : c.iso.toLowerCase(),
      regionLabel: c.region || c.name,
    };
  }

  const regions = [...new Set(countries.map((c) => c.region).filter(Boolean))];
  if (regions.length === 1) {
    const regionLabel = regions[0]!;
    const key = REGION_NAME_TO_KEY[regionLabel.toLowerCase()] ?? slugKey(regionLabel);
    const emblem =
      key === "as" || /asia/i.test(regionLabel)
        ? "asia"
        : key === "af" || /africa/i.test(regionLabel)
          ? "africa"
          : key === "gl" || /global|world/i.test(regionLabel)
            ? "global"
            : undefined;
    return { key, name: regionLabel, regionLabel, emblem };
  }

  return { key: "gl", name: "Global", regionLabel: "Global", emblem: "global" };
}

/** Group platform bundles into destinations the app can browse. */
export function destinationsFromBundles(bundles: CatalogueBundle[]): CatalogueDestination[] {
  const map = new Map<
    string,
    {
      meta: CatalogueDestination;
      countryMap: Map<string, { iso: string; name: string }>;
      minPrice: number;
      planCount: number;
    }
  >();

  for (const bundle of bundles) {
    const dest = destinationOf(bundle);
    const existing = map.get(dest.key);
    const price = Number(bundle.price) || 0;
    if (!existing) {
      const countryMap = new Map(
        bundle.countries.map((c) => [c.iso, { iso: c.iso, name: c.name }] as const),
      );
      map.set(dest.key, {
        countryMap,
        minPrice: price,
        planCount: 1,
        meta: {
          key: dest.key,
          name: dest.name,
          short: dest.name.length > 10 ? dest.name.slice(0, 9) : dest.name,
          iso: dest.iso,
          emblem: dest.emblem,
          regionLabel: dest.regionLabel,
          from: price,
          countries: countryMap.size,
          countryList: [...countryMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
          planCount: 1,
          accent: ISO_ACCENT[(dest.iso ?? dest.key).toUpperCase()] ?? "#0EA5E9",
        },
      });
    } else {
      for (const c of bundle.countries) {
        existing.countryMap.set(c.iso, { iso: c.iso, name: c.name });
      }
      existing.minPrice =
        existing.minPrice > 0 && price > 0
          ? Math.min(existing.minPrice, price)
          : existing.minPrice || price;
      existing.planCount += 1;
      existing.meta = {
        ...existing.meta,
        from: existing.minPrice,
        countries: existing.countryMap.size,
        countryList: [...existing.countryMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
        planCount: existing.planCount,
      };
    }
  }

  return [...map.values()]
    .map((v) => v.meta)
    .sort((a, b) => {
      if (b.planCount !== a.planCount) return b.planCount - a.planCount;
      return a.name.localeCompare(b.name);
    });
}

function enrichSimBundle(
  row: Omit<CatalogueBundle, "currency" | "groups" | "speed" | "autostart" | "countries"> & {
    countries: Array<{ iso: string; name: string; region: string }>;
  },
): CatalogueBundle {
  return {
    ...row,
    currency: "USD",
    groups: ["Standard eSIM Bundles"],
    speed: ["4G"],
    autostart: true,
    countries: row.countries.map((c) => ({ ...c, networks: [] })),
  };
}

const SIM_CATALOGUE: CatalogueBundle[] = SIM_CATALOGUE_RAW.map(enrichSimBundle);

function pickChargeAmount(preferred: unknown, fallback: number): number {
  const n = Number(preferred);
  if (Number.isFinite(n) && n > 0) return n;
  return fallback;
}

export type InstallDetails = {
  iccid?: string;
  matchingId?: string;
  smdpAddress?: string;
  activationCode?: string;
  profileStatus?: string;
};

function strField(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = row[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function installFromRow(raw: unknown): InstallDetails | null {
  const row = asRecord(raw);
  if (!row) return null;
  const iccid = strField(row, ["iccid", "ICCID"]);
  const matchingId = strField(row, ["matchingId", "matching_id", "MatchingId"]);
  const smdpAddress = strField(row, ["smdpAddress", "smdp", "smdp_address", "SMDP"]);
  let activationCode = strField(row, ["activationCode", "activation_code", "lpa"]);
  if (!activationCode && matchingId && smdpAddress) {
    const host = smdpAddress.replace(/^https?:\/\//i, "");
    activationCode = `LPA:1$${host}$${matchingId}`;
  } else if (!activationCode && matchingId) {
    activationCode = matchingId;
  }
  if (!iccid && !activationCode) return null;
  return {
    iccid,
    matchingId,
    smdpAddress,
    activationCode,
    profileStatus: strField(row, ["profileStatus", "profile_status", "status"]),
  };
}

/** Pull install details from order create response or assignments payload. */
function extractInstallDetails(payload: unknown): InstallDetails | null {
  if (!payload) return null;
  if (Array.isArray(payload)) {
    for (const row of payload) {
      const hit = installFromRow(row);
      if (hit) return hit;
    }
    return null;
  }

  const root = asRecord(payload);
  if (!root) return null;

  // Direct assignment object
  const direct = installFromRow(root);
  if (direct?.iccid || direct?.activationCode) return direct;

  // Transaction response: order[].esims[]
  const orderRows = Array.isArray(root.order) ? root.order : [];
  for (const line of orderRows) {
    const lineObj = asRecord(line);
    if (!lineObj) continue;
    const esims = Array.isArray(lineObj.esims) ? lineObj.esims : [];
    for (const e of esims) {
      const hit = installFromRow(e);
      if (hit) return hit;
    }
    if (Array.isArray(lineObj.iccids) && typeof lineObj.iccids[0] === "string") {
      return { iccid: String(lineObj.iccids[0]) };
    }
  }

  // Assignments wrappers
  for (const key of ["esims", "apply", "assignments", "data"]) {
    const list = root[key];
    if (Array.isArray(list)) {
      for (const row of list) {
        const hit = installFromRow(row);
        if (hit) return hit;
      }
    }
  }

  return null;
}

function bytesToMb(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  // eSIM Go often reports remainingQuantity in bytes
  if (value > 100_000) return Math.round(value / (1024 * 1024));
  return Math.round(value);
}

function qrUrlFor(activationCode: string) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(activationCode)}`;
}

export class EsimService {
  /** Live catalogue is paginated; fetch pages and normalize to a stable shape. */
  private async fetchLiveCatalogue(query?: Record<string, string>): Promise<CatalogueBundle[]> {
    const all: CatalogueBundle[] = [];
    const seen = new Set<string>();
    let page = 1;
    let pageCount = 1;

    do {
      const payload = await esimGoClient.getCatalogue({
        ...query,
        page,
        perPage: Number(query?.perPage ?? 100),
      });
      const obj = asRecord(payload);
      pageCount = Math.max(1, Number(obj?.pageCount ?? obj?.pages ?? 1));

      for (const row of extractBundleRows(payload)) {
        const bundle = normalizeBundle(row);
        if (!bundle || seen.has(bundle.name)) continue;
        seen.add(bundle.name);
        all.push(bundle);
      }
      page += 1;
    } while (page <= pageCount && page <= 25);

    return all;
  }

  private async resolveBundle(bundleName: string): Promise<CatalogueBundle | null> {
    if (useEsimGoLive()) {
      try {
        const detail = await esimGoClient.getCatalogueBundle(bundleName);
        return normalizeBundle(detail);
      } catch {
        const all = await this.fetchLiveCatalogue();
        return all.find((b) => b.name === bundleName) ?? null;
      }
    }
    return SIM_CATALOGUE.find((b) => b.name === bundleName) ?? null;
  }

  async catalogue(query?: Record<string, string>) {
    if (useEsimGoLive()) {
      const bundles = await this.fetchLiveCatalogue(query);
      return {
        bundles,
        destinations: destinationsFromBundles(bundles),
        provider: "esim-go",
        simulated: false,
        count: bundles.length,
      };
    }

    const region = query?.region?.trim();
    const countries = String(query?.countries ?? "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    let rows = SIM_CATALOGUE;
    if (region) {
      const r = region.toLowerCase();
      rows = rows.filter((b) => b.countries.some((c) => c.region.toLowerCase() === r || c.iso.toLowerCase() === r));
    }
    if (countries.length) {
      rows = rows.filter((b) => b.countries.some((c) => countries.includes(c.iso)));
    }

    return {
      bundles: rows,
      destinations: destinationsFromBundles(rows),
      provider: "simulated",
      simulated: true,
      count: rows.length,
    };
  }

  async list(userId: string) {
    return prisma.esim.findMany({
      where: { userId },
      include: { orders: true },
      orderBy: { createdAt: "desc" },
    });
  }

  async get(userId: string, id: string) {
    const esim = await prisma.esim.findFirst({
      where: { id, userId },
      include: { orders: true },
    });
    if (!esim) throw new NotFoundError("eSIM not found");
    return esim;
  }

  async purchase(userId: string, input: z.infer<typeof purchaseSchema>) {
    const catalogBundle = await this.resolveBundle(input.bundleName);
    let chargeAmount = pickChargeAmount(catalogBundle?.price, input.amount);

    if (useEsimGoLive()) {
      const validation = (await esimGoClient.validateOrder({
        item: input.bundleName,
        quantity: input.quantity,
      })) as Record<string, unknown>;
      chargeAmount = pickChargeAmount(validation.total ?? validation.price, chargeAmount);
    }

    const dataMb = catalogBundle?.unlimited
      ? 0
      : catalogBundle?.dataMb && catalogBundle.dataMb > 0
        ? catalogBundle.dataMb
        : 1024;
    const days = catalogBundle?.days && catalogBundle.days > 0 ? catalogBundle.days : 7;

    const walletTx = await walletService.debit({
      userId,
      currency: input.currency,
      amount: chargeAmount,
      type: "ESIM_PURCHASE",
      description: `eSIM ${input.bundleName}`,
      provider: useEsimGoLive() ? "esim-go" : "simulated",
    });

    try {
      if (!useEsimGoLive()) {
        const iccid = simIccid();
        const matchingId = simRef("ACT");
        const smdpAddress = "smdp.fulus.local";
        const activationCode = `LPA:1$${smdpAddress}$${matchingId}`;
        const esim = await prisma.esim.create({
          data: {
            userId,
            provider: "simulated",
            iccid,
            status: "READY",
            bundleName: input.bundleName,
            label: input.label ?? catalogBundle?.description ?? input.bundleName,
            activationCode,
            dataRemainingMb: dataMb || null,
            expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
            qrCodeUrl: qrUrlFor(activationCode),
            providerPayload: asJson({
              simulated: true,
              catalogue: catalogBundle,
              matchingId,
              smdpAddress,
            }),
            orders: {
              create: {
                transactionId: walletTx.id,
                bundleName: input.bundleName,
                quantity: input.quantity,
                orderReference: simRef("ESIM"),
                status: "SUCCESS",
                providerPayload: asJson({ simulated: true }),
              },
            },
          },
          include: { orders: true },
        });
        await createInboxMessage({
          userId,
          title: "eSIM ready to install",
          body: `${esim.label ?? "Your eSIM"} is ready. Open My eSIMs to scan the QR code.`,
          category: "esim",
        });
        return esim;
      }

      const providerResult = (await esimGoClient.createOrder({
        item: input.bundleName,
        quantity: input.quantity,
        assign: true,
        allowReassign: true,
      })) as Record<string, unknown>;

      const orderReference =
        typeof providerResult.orderReference === "string"
          ? providerResult.orderReference
          : typeof providerResult.order_reference === "string"
            ? providerResult.order_reference
            : undefined;

      let install = extractInstallDetails(providerResult);

      if ((!install?.iccid || !install.activationCode) && orderReference) {
        try {
          const assignments = await esimGoClient.getAssignments(orderReference);
          install = extractInstallDetails(assignments) ?? install;
        } catch {
          // Assignment fetch can lag — sync endpoint / webhook can fill later
        }
      }

      const activationCode = install?.activationCode;
      const esim = await prisma.esim.create({
        data: {
          userId,
          provider: "esim-go",
          iccid: install?.iccid,
          status: install?.iccid || activationCode ? "READY" : "ORDERED",
          bundleName: input.bundleName,
          label: input.label ?? catalogBundle?.description ?? input.bundleName,
          activationCode,
          dataRemainingMb: dataMb || null,
          expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
          qrCodeUrl: activationCode ? qrUrlFor(activationCode) : undefined,
          providerPayload: asJson({
            order: providerResult,
            catalogue: catalogBundle,
            matchingId: install?.matchingId,
            smdpAddress: install?.smdpAddress,
            orderReference,
          }),
          orders: {
            create: {
              transactionId: walletTx.id,
              bundleName: input.bundleName,
              quantity: input.quantity,
              orderReference,
              status: "SUCCESS",
              providerPayload: asJson(providerResult),
            },
          },
        },
        include: { orders: true },
      });

      await createInboxMessage({
        userId,
        title: esim.status === "READY" ? "eSIM ready to install" : "eSIM order placed",
        body:
          esim.status === "READY"
            ? `${esim.label ?? "Your eSIM"} is ready. Open My eSIMs to scan the QR code.`
            : `${esim.label ?? "Your eSIM"} was ordered. Activation details will appear shortly.`,
        category: "esim",
      });

      return esim;
    } catch (error) {
      await walletService.credit({
        userId,
        currency: input.currency,
        amount: chargeAmount,
        type: "ADJUSTMENT",
        description: `Refund failed eSIM ${walletTx.reference}`,
        provider: "esim-go",
      });
      throw error instanceof Error ? error : new AppError("eSIM purchase failed");
    }
  }

  /** Re-fetch SM-DP+ / ICCID from eSIM Go when assignment lagged after purchase. */
  async sync(userId: string, id: string) {
    const esim = await this.get(userId, id);
    if (!useEsimGoLive()) return esim;

    const payload = asRecord(esim.providerPayload) ?? {};
    const orderRef =
      (typeof payload.orderReference === "string" && payload.orderReference) ||
      esim.orders.find((o) => o.orderReference)?.orderReference;

    if (!orderRef && esim.iccid && esim.activationCode) return esim;
    if (!orderRef) {
      throw new AppError("No order reference to sync — wait a moment and try again", 409);
    }

    const assignments = await esimGoClient.getAssignments(orderRef);
    const install = extractInstallDetails(assignments);
    if (!install?.iccid && !install?.activationCode) {
      return esim;
    }

    const activationCode = install.activationCode ?? esim.activationCode ?? undefined;
    const updated = await prisma.esim.update({
      where: { id: esim.id },
      data: {
        iccid: install.iccid ?? esim.iccid,
        activationCode,
        qrCodeUrl: activationCode ? qrUrlFor(activationCode) : esim.qrCodeUrl,
        status: esim.status === "ORDERED" ? "READY" : esim.status,
        providerPayload: asJson({
          ...payload,
          matchingId: install.matchingId ?? payload.matchingId,
          smdpAddress: install.smdpAddress ?? payload.smdpAddress,
          lastSyncAt: new Date().toISOString(),
          lastAssignment: assignments,
        }),
      },
      include: { orders: true },
    });

    if (esim.status === "ORDERED" && updated.status === "READY") {
      await createInboxMessage({
        userId,
        title: "eSIM ready to install",
        body: `${updated.label ?? "Your eSIM"} activation details are ready.`,
        category: "esim",
      });
    }

    return updated;
  }

  async topup(userId: string, id: string, input: z.infer<typeof topupSchema>) {
    const esim = await this.get(userId, id);
    const catalogBundle = await this.resolveBundle(input.bundleName);
    let chargeAmount = pickChargeAmount(catalogBundle?.price, input.amount);
    const addMb =
      input.dataMb ??
      (catalogBundle?.unlimited ? 0 : catalogBundle?.dataMb && catalogBundle.dataMb > 0 ? catalogBundle.dataMb : 1024);
    const days = catalogBundle?.days && catalogBundle.days > 0 ? catalogBundle.days : 14;

    if (useEsimGoLive()) {
      if (!esim.iccid) throw new AppError("eSIM has no ICCID yet — wait until assignment completes");
      const validation = (await esimGoClient.validateOrder({
        item: input.bundleName,
        quantity: 1,
      })) as Record<string, unknown>;
      chargeAmount = pickChargeAmount(validation.total ?? validation.price, chargeAmount);
    }

    const walletTx = await walletService.debit({
      userId,
      currency: input.currency,
      amount: chargeAmount,
      type: "ESIM_PURCHASE",
      description: `eSIM topup ${input.bundleName}`,
      provider: useEsimGoLive() ? "esim-go" : "simulated",
    });

    try {
      let providerPayload: Record<string, unknown> = {
        simulated: !useEsimGoLive(),
        topupMb: addMb,
        catalogue: catalogBundle,
      };

      if (useEsimGoLive() && esim.iccid) {
        const providerResult = (await esimGoClient.createOrder({
          item: input.bundleName,
          quantity: 1,
          assign: true,
          iccid: esim.iccid,
          allowReassign: true,
        })) as Record<string, unknown>;
        providerPayload = { ...providerPayload, order: providerResult };
      }

      const updated = await prisma.esim.update({
        where: { id: esim.id },
        data: {
          dataRemainingMb: addMb > 0 ? (esim.dataRemainingMb ?? 0) + addMb : esim.dataRemainingMb,
          status: "INSTALLED",
          expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
          orders: {
            create: {
              transactionId: walletTx.id,
              bundleName: input.bundleName,
              quantity: 1,
              orderReference:
                typeof providerPayload.order === "object" &&
                providerPayload.order &&
                typeof (providerPayload.order as Record<string, unknown>).orderReference === "string"
                  ? String((providerPayload.order as Record<string, unknown>).orderReference)
                  : simRef("TOP"),
              status: "SUCCESS",
              providerPayload: asJson(providerPayload),
            },
          },
        },
        include: { orders: true },
      });

      return { esim: updated, transaction: walletTx };
    } catch (error) {
      await walletService.credit({
        userId,
        currency: input.currency,
        amount: chargeAmount,
        type: "ADJUSTMENT",
        description: `Refund failed eSIM topup ${walletTx.reference}`,
        provider: "esim-go",
      });
      throw error instanceof Error ? error : new AppError("eSIM topup failed");
    }
  }

  async patch(userId: string, id: string, input: z.infer<typeof patchEsimSchema>) {
    await this.get(userId, id);
    return prisma.esim.update({
      where: { id },
      data: {
        ...(input.label ? { label: input.label } : {}),
        ...(input.status ? { status: input.status } : {}),
      },
      include: { orders: true },
    });
  }

  async usage(userId: string, id: string) {
    const esim = await this.get(userId, id);

    if (useEsimGoLive() && esim.iccid && esim.bundleName) {
      try {
        const status = (await esimGoClient.getBundleStatus(esim.iccid, esim.bundleName)) as Record<string, unknown>;
        const remainingRaw = Number(
          status.remainingQuantity ?? status.dataRemaining ?? status.remainingMb ?? esim.dataRemainingMb ?? 0,
        );
        const initialRaw = Number(
          status.initialQuantity ?? status.dataAmount ?? status.totalMb ?? remainingRaw,
        );
        const remaining = bytesToMb(remainingRaw);
        const total = bytesToMb(initialRaw) || remaining;
        if (remaining >= 0 && esim.dataRemainingMb !== remaining) {
          await prisma.esim.update({
            where: { id: esim.id },
            data: {
              dataRemainingMb: remaining,
              status: remaining === 0 && !Boolean(status.unlimited) ? "DEPLETED" : esim.status,
            },
          });
        }
        return {
          iccid: esim.iccid,
          dataRemainingMb: remaining,
          dataUsedMb: Math.max(0, total - remaining),
          dataTotalMb: total,
          expiresAt: status.endTime ?? esim.expiresAt,
          status: remaining === 0 ? "DEPLETED" : esim.status,
          simulated: false,
          provider: status,
        };
      } catch {
        // Fall through to local estimate
      }
    }

    const catalogue = asRecord(asRecord(esim.providerPayload)?.catalogue);
    const catalogMb = Number(catalogue?.dataMb ?? 0);
    const remaining = esim.dataRemainingMb ?? catalogMb ?? 0;
    const total = catalogMb > 0 ? catalogMb : remaining > 0 ? remaining : 2048;
    return {
      iccid: esim.iccid,
      dataRemainingMb: remaining,
      dataUsedMb: Math.max(0, total - remaining),
      dataTotalMb: total,
      expiresAt: esim.expiresAt,
      status: esim.status,
      simulated: esim.provider === "simulated",
    };
  }

  /** Apply live usage / lifecycle updates from eSIM Go callbacks. */
  async applyWebhookUpdate(payload: Record<string, unknown>) {
    const iccid = strField(payload, ["iccid", "ICCID"]);
    if (!iccid) return null;

    const esim = await prisma.esim.findFirst({ where: { iccid } });
    if (!esim) return null;

    const alertType = String(payload.alertType ?? payload.event ?? payload.type ?? "").toLowerCase();
    const bundle = asRecord(payload.bundle) ?? {};
    const remainingRaw = Number(bundle.remainingQuantity ?? payload.remainingQuantity ?? NaN);
    const initialRaw = Number(bundle.initialQuantity ?? payload.initialQuantity ?? NaN);
    const remaining = Number.isFinite(remainingRaw) ? bytesToMb(remainingRaw) : null;
    const endTime = strField(bundle, ["endTime", "end_time"]);

    const data: Prisma.EsimUpdateInput = {
      providerPayload: asJson({
        ...asRecord(esim.providerPayload),
        lastWebhook: payload,
        lastWebhookAt: new Date().toISOString(),
      }),
    };

    if (remaining != null) {
      data.dataRemainingMb = remaining;
      if (remaining === 0) data.status = "DEPLETED";
    }
    if (endTime) data.expiresAt = new Date(endTime);

    if (alertType.includes("first") && (alertType.includes("attach") || alertType.includes("use"))) {
      if (esim.status === "READY" || esim.status === "ORDERED") data.status = "INSTALLED";
    }
    if (alertType.includes("deleted") || alertType.includes("deletion")) {
      data.status = "EXPIRED";
    }

    const updated = await prisma.esim.update({ where: { id: esim.id }, data });

    if (remaining != null && (remaining === 0 || alertType.includes("utilisation") || alertType.includes("usage"))) {
      const pct =
        Number.isFinite(initialRaw) && initialRaw > 0
          ? Math.round((1 - remainingRaw / initialRaw) * 100)
          : remaining === 0
            ? 100
            : null;
      await createInboxMessage({
        userId: esim.userId,
        title: remaining === 0 ? "eSIM data depleted" : "eSIM usage update",
        body:
          remaining === 0
            ? `${esim.label ?? "Your eSIM"} has no data left. Top up to stay online.`
            : pct != null
              ? `${esim.label ?? "Your eSIM"} is about ${pct}% used (${remaining} MB left).`
              : `${esim.label ?? "Your eSIM"} usage was updated (${remaining} MB left).`,
        category: "esim",
      });
    }

    return updated;
  }
}

export const esimService = new EsimService();
