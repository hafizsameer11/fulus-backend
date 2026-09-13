import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { AppError, NotFoundError } from "../../../lib/errors.js";
import { esimGoClient } from "../../../providers/esim-go/client.js";
import { walletService } from "../../wallet/services/wallet.service.js";
import { simIccid, simRef, useEsimGoLive } from "../../../lib/simulate.js";

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
export type CatalogueBundle = {
  name: string;
  description: string;
  dataMb: number;
  days: number;
  unlimited: boolean;
  price: number;
  countries: Array<{ iso: string; name: string; region: string }>;
};

const SIM_CATALOGUE: CatalogueBundle[] = [
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

function normalizeCountry(raw: unknown): { iso: string; name: string; region: string } | null {
  const c = asRecord(raw);
  if (!c) return null;
  const nested = asRecord(c.country);
  const iso = String(c.iso ?? nested?.iso ?? "").toUpperCase();
  if (!iso) return null;
  return {
    iso,
    name: String(c.name ?? nested?.name ?? iso),
    region: String(c.region ?? nested?.region ?? ""),
  };
}

function normalizeBundle(raw: unknown): CatalogueBundle | null {
  const b = asRecord(raw);
  if (!b) return null;
  const name = String(b.name ?? "").trim();
  if (!name) return null;

  const countriesRaw = Array.isArray(b.countries)
    ? b.countries
    : Array.isArray(b.countryNetworks)
      ? b.countryNetworks
      : [];
  const countries = countriesRaw.map(normalizeCountry).filter((c): c is NonNullable<typeof c> => Boolean(c));

  const dataMb = Number(b.dataAmount ?? b.dataMb ?? 0);
  const days = Number(b.duration ?? b.days ?? 0);
  const unlimited = Boolean(b.unlimited);
  const price = Number(b.price ?? 0);

  return {
    name,
    description: String(b.description ?? name),
    dataMb: Number.isFinite(dataMb) ? dataMb : 0,
    days: Number.isFinite(days) ? days : 0,
    unlimited,
    price: Number.isFinite(price) ? price : 0,
    countries,
  };
}

function pickChargeAmount(preferred: unknown, fallback: number): number {
  const n = Number(preferred);
  if (Number.isFinite(n) && n > 0) return n;
  return fallback;
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
      return { bundles, simulated: false, count: bundles.length };
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

    return { bundles: rows, simulated: true, count: rows.length };
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
        const activationCode = `LPA:1$sim.fulus.local$${simRef("ACT")}`;
        return prisma.esim.create({
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
            qrCodeUrl: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(activationCode)}`,
            providerPayload: asJson({
              simulated: true,
              catalogue: catalogBundle,
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
      }

      const providerResult = (await esimGoClient.createOrder({
        item: input.bundleName,
        quantity: input.quantity,
        assign: true,
      })) as Record<string, unknown>;

      const orderReference =
        typeof providerResult.orderReference === "string"
          ? providerResult.orderReference
          : typeof providerResult.order_reference === "string"
            ? providerResult.order_reference
            : undefined;

      let iccid: string | undefined;
      let activationCode: string | undefined;

      if (orderReference) {
        try {
          const assignments = (await esimGoClient.getAssignments(orderReference)) as Record<string, unknown>;
          const list = Array.isArray(assignments)
            ? assignments
            : Array.isArray(assignments.esims)
              ? assignments.esims
              : [];
          const first = list[0] as Record<string, unknown> | undefined;
          if (first) {
            iccid = typeof first.iccid === "string" ? first.iccid : undefined;
            const matchingId =
              typeof first.matchingId === "string"
                ? first.matchingId
                : typeof first.matching_id === "string"
                  ? first.matching_id
                  : undefined;
            const smdp =
              typeof first.smdpAddress === "string"
                ? first.smdpAddress
                : typeof first.smdp === "string"
                  ? first.smdp
                  : undefined;
            if (typeof first.activationCode === "string") {
              activationCode = first.activationCode;
            } else if (matchingId && smdp) {
              activationCode = `LPA:1$${smdp}$${matchingId}`;
            } else if (matchingId) {
              activationCode = matchingId;
            }
          }
        } catch {
          // Assignment fetch can lag — webhook / later poll can fill ICCID
        }
      }

      return prisma.esim.create({
        data: {
          userId,
          provider: "esim-go",
          iccid,
          status: iccid ? "READY" : "ORDERED",
          bundleName: input.bundleName,
          label: input.label ?? catalogBundle?.description ?? input.bundleName,
          activationCode,
          dataRemainingMb: dataMb || null,
          expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
          qrCodeUrl: activationCode
            ? `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(activationCode)}`
            : undefined,
          providerPayload: asJson({ order: providerResult, catalogue: catalogBundle }),
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
        const remaining = Number(status.dataRemaining ?? status.remainingMb ?? esim.dataRemainingMb ?? 0);
        const total = Number(status.dataAmount ?? status.totalMb ?? remaining);
        return {
          iccid: esim.iccid,
          dataRemainingMb: remaining,
          dataUsedMb: Math.max(0, total - remaining),
          dataTotalMb: total,
          expiresAt: esim.expiresAt,
          status: esim.status,
          simulated: false,
          provider: status,
        };
      } catch {
        // Fall through to local estimate
      }
    }

    const total = esim.dataRemainingMb && esim.dataRemainingMb > 0 ? esim.dataRemainingMb * 2 : 2048;
    const remaining = esim.dataRemainingMb ?? 0;
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
}

export const esimService = new EsimService();
