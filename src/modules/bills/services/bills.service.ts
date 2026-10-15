import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { strowalletClient } from "../../../providers/strowallet/client.js";
import { walletService } from "../../wallet/services/wallet.service.js";
import { useStrowalletLive } from "../../../lib/simulate.js";
import { AppError } from "../../../lib/errors.js";
import { assertKillSwitchOff, KILL_SWITCH_KEYS } from "../../../lib/kill-switch.js";
import { maybeSendEducationPinEmail } from "../../../lib/tx-receipt-email.js";

export const payBillSchema = z.object({
  category: z.enum(["AIRTIME", "DATA", "ELECTRICITY", "CABLE", "BETTING", "EDUCATION", "OTHER"]),
  serviceId: z.string().min(1),
  customerRef: z.string().min(1),
  amount: z.number().positive(),
  phone: z.string().optional(),
  variationCode: z.string().optional(),
  /** Plan display name — required by some bill rails for DATA/CABLE */
  serviceName: z.string().min(1).optional(),
  currency: z.enum(["NGN"]).default("NGN"),
});

export const verifyMeterSchema = z.object({
  billersCode: z.string().min(1),
  serviceID: z.string().min(1),
  type: z.enum(["prepaid", "postpaid"]),
});

type CatalogVariation = {
  id?: string;
  code: string;
  name: string;
  amount: number | null;
  isActive: boolean;
};

/** Category floors — electricity uses per-disco mins (see electricityMinNgn). */
export const BILL_MIN_AMOUNT_NGN: Record<string, number> = {
  AIRTIME: 50,
  ELECTRICITY: 500,
  DATA: 50,
  CABLE: 100,
  EDUCATION: 500,
  BETTING: 100,
  OTHER: 50,
};

/**
 * Strowallet / DisCo purchase floors (NGN). Flat ₦1,000 was wrong — e.g. IBEDC is ₦5,000
 * and most Lagos/Abuja discos accept ₦500. Keys: Strowallet service_name + our catalog ids.
 */
export const ELECTRICITY_MIN_BY_CODE: Record<string, number> = {
  "ikeja-electric": 500,
  ikedc: 500,
  "eko-electric": 500,
  ekedc: 500,
  "abuja-electric": 500,
  aedc: 500,
  "kano-electric": 500,
  kedco: 500,
  "portharcourt-electric": 500,
  phed: 500,
  "jos-electric": 500,
  jed: 500,
  "kaduna-electric": 1000,
  kaedco: 1000,
  "enugu-electric": 1000,
  eedc: 1000,
  "benin-electric": 1000,
  bedc: 1000,
  "ibadan-electric": 5000,
  ibedc: 5000,
  "aba-electric": 500,
  aba: 500,
  "yola-electric": 500,
  yedc: 500,
};

export function electricityMinNgn(providerCode?: string | null, serviceId?: string | null): number {
  const keys = [providerCode, serviceId].map((k) => String(k ?? "").trim().toLowerCase()).filter(Boolean);
  for (const k of keys) {
    if (ELECTRICITY_MIN_BY_CODE[k] != null) return ELECTRICITY_MIN_BY_CODE[k]!;
  }
  return BILL_MIN_AMOUNT_NGN.ELECTRICITY;
}

/** Catalog id → Strowallet service_name when DB providerCode is missing. */
const ELECTRICITY_SERVICE_ALIAS: Record<string, string> = {
  ikedc: "ikeja-electric",
  ekedc: "eko-electric",
  aedc: "abuja-electric",
  ibedc: "ibadan-electric",
  phed: "portharcourt-electric",
  kedco: "kano-electric",
  kaedco: "kaduna-electric",
  jed: "jos-electric",
  eedc: "enugu-electric",
  bedc: "benin-electric",
  aba: "aba-electric",
  yedc: "yola-electric",
};

function resolveElectricityServiceName(providerCode?: string | null, serviceId?: string | null): string {
  const fromDb = String(providerCode ?? "").trim();
  if (fromDb) return fromDb;
  const id = String(serviceId ?? "").trim().toLowerCase();
  return ELECTRICITY_SERVICE_ALIAS[id] ?? String(serviceId ?? "").trim();
}

/** Strowallet educational has no plans endpoint — expose the live product(s). */
const EDUCATION_PRODUCTS: CatalogVariation[] = [
  { code: "waecdirect", name: "WAEC Result Checker PIN", amount: 3400, isActive: true },
];

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/** Strowallet airtime: mtn | glo | airtel | etisalat */
function airtimeServiceName(serviceId: string): string {
  const id = serviceId.toLowerCase().replace(/-airtime$/, "");
  if (id === "9mobile" || id === "etisalat") return "etisalat";
  return id;
}

/** Strowallet data: mtn-data | airtel-data | glo-data | etisalat-data */
function dataServiceId(serviceId: string): string {
  const id = serviceId.toLowerCase();
  if (id === "9mobile-data" || id === "etisalat-data") return "etisalat-data";
  if (id.endsWith("-data")) return id;
  if (id === "9mobile" || id === "etisalat") return "etisalat-data";
  return `${id}-data`;
}

function digRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function cleanTokenValue(raw: string): string | undefined {
  let t = raw.trim();
  if (!t) return undefined;
  t = t.replace(/^Token\s*:?\s*/i, "").trim();
  // Prefer digit runs (ignore prose around the token)
  const match = t.match(/(\d[\d\s-]{6,}\d)/);
  if (match?.[1]) t = match[1].replace(/[\s-]/g, "");
  else t = t.replace(/[\s-]/g, "");
  if (!/^\d{8,}$/.test(t)) return undefined;
  return t;
}

/** Format prepaid token as XXXX-XXXX-XXXX for meter entry UI. */
export function formatRechargeToken(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 8) return raw.trim();
  return digits.replace(/(.{4})/g, "$1-").replace(/-$/, "");
}

function extractToken(providerResult: unknown): string | undefined {
  if (!providerResult || typeof providerResult !== "object") return undefined;
  const root = digRecord(providerResult)!;
  const response = digRecord(root.response);
  const data = digRecord(root.data);
  const content = digRecord(response?.content);
  const transactions = digRecord(content?.transactions);

  const digitCandidates: unknown[] = [
    root.token,
    root.Token,
    root.pin,
    root.Pin,
    root.PIN,
    root.purchased_code,
    root.purchasedCode,
    response?.Token,
    response?.token,
    response?.pin,
    response?.Pin,
    response?.purchased_code,
    response?.purchasedCode,
    data?.token,
    data?.Token,
    data?.pin,
    data?.purchased_code,
    transactions?.token,
    transactions?.Token,
    transactions?.purchased_code,
    root.message,
    response?.message,
  ];

  for (const c of digitCandidates) {
    if (typeof c === "string") {
      const cleaned = cleanTokenValue(c);
      if (cleaned) return cleaned;
    }
  }

  // Education purchased_code / pin fields may be alphanumeric (skip free-text messages).
  const pinFields: unknown[] = [
    root.pin,
    root.Pin,
    root.PIN,
    root.purchased_code,
    root.purchasedCode,
    response?.pin,
    response?.Pin,
    response?.purchased_code,
    response?.purchasedCode,
    data?.pin,
    data?.purchased_code,
    transactions?.purchased_code,
  ];
  for (const c of pinFields) {
    if (typeof c !== "string") continue;
    const loose = c.replace(/^Token\s*:?\s*/i, "").trim().replace(/\s+/g, "");
    if (
      loose.length >= 4 &&
      loose.length <= 64 &&
      /^[A-Za-z0-9-]+$/.test(loose) &&
      !/^(success|successful|pending|failed|ok)$/i.test(loose)
    ) {
      return loose;
    }
  }

  // Deep scan common string fields for "Token : 1234…"
  const blob = JSON.stringify(providerResult);
  const fromBlob = blob.match(/Token\s*:?\s*(\\?")?(\d[\d\s-]{6,}\d)/i);
  if (fromBlob?.[2]) {
    const cleaned = cleanTokenValue(fromBlob[2]);
    if (cleaned) return cleaned;
  }
  return undefined;
}

function extractUnits(providerResult: unknown): string | undefined {
  const root = digRecord(providerResult);
  if (!root) return undefined;
  const response = digRecord(root.response);
  const data = digRecord(root.data);
  const candidates = [response?.Units, response?.units, data?.Units, data?.units, root.Units, root.units];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return String(c);
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  const msg = typeof root.message === "string" ? root.message : "";
  const m = msg.match(/units?\s*(?:are|=|:)?\s*([0-9]+(?:\.[0-9]+)?)/i);
  return m?.[1];
}

function extractCustomerName(providerResult: unknown): string | undefined {
  const root = digRecord(providerResult);
  if (!root) return undefined;
  const response = digRecord(root.response);
  const data = digRecord(root.data);
  const content = digRecord(root.content) ?? digRecord(response?.content) ?? digRecord(data?.content);
  const nested = digRecord(data?.data) ?? digRecord(response?.data);
  const candidates = [
    root.customer_name,
    root.Customer_Name,
    root.CustomerName,
    root.customerName,
    root.name,
    response?.CustomerName,
    response?.customer_name,
    response?.Customer_Name,
    response?.customerName,
    response?.name,
    data?.customer_name,
    data?.Customer_Name,
    data?.CustomerName,
    data?.customerName,
    data?.name,
    content?.customer_name,
    content?.CustomerName,
    content?.customerName,
    nested?.customer_name,
    nested?.CustomerName,
    nested?.customerName,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  // Last resort: scan JSON blob for customer_name / CustomerName fields.
  try {
    const blob = JSON.stringify(providerResult);
    const m = blob.match(/"(?:customer_name|Customer_Name|CustomerName|customerName)"\s*:\s*"([^"]{2,120})"/i);
    if (m?.[1]?.trim()) return m[1].trim();
  } catch {
    // ignore
  }
  return undefined;
}

function extractMeterAddress(providerResult: unknown): string | null {
  const root = digRecord(providerResult);
  if (!root) return null;
  const response = digRecord(root.response);
  const data = digRecord(root.data);
  const candidates = [root.address, root.Address, response?.address, response?.Address, data?.address, data?.Address];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return null;
}

function asPlanList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  const root = raw as Record<string, unknown>;

  // Prefer nested plan arrays (Strowallet docs typo: "varations")
  const nestedKeys = ["variations", "varations", "plans", "data", "content", "result"];
  for (const key of nestedKeys) {
    if (Array.isArray(root[key])) return root[key] as unknown[];
  }

  if (root.data && typeof root.data === "object") {
    const data = root.data as Record<string, unknown>;
    for (const key of nestedKeys) {
      if (Array.isArray(data[key])) return data[key] as unknown[];
    }
  }

  if (root.content && typeof root.content === "object") {
    const content = root.content as Record<string, unknown>;
    for (const key of nestedKeys) {
      if (Array.isArray(content[key])) return content[key] as unknown[];
    }
  }

  return [];
}

function normalizeProviderPlans(raw: unknown): CatalogVariation[] {
  const out: CatalogVariation[] = [];
  for (const row of asPlanList(raw)) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const code = String(r.variation_code ?? r.variationCode ?? r.code ?? r.plan_code ?? r.planCode ?? "").trim();
    const name = String(r.name ?? r.plan_name ?? r.planName ?? r.description ?? code).trim();
    if (!code || !name) continue;
    const amountRaw = r.variation_amount ?? r.variationAmount ?? r.amount ?? r.price ?? r.fixedPrice;
    const amount = amountRaw == null || amountRaw === "" ? null : Number(amountRaw);
    out.push({
      code,
      name,
      amount: Number.isFinite(amount as number) ? (amount as number) : null,
      isActive: true,
    });
  }
  return out;
}

export class BillsService {
  async list(userId: string) {
    return prisma.billPayment.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Catalog for the app. Never returns DB seed/demo plan lists.
   * DATA/CABLE variations come from Strowallet when live; otherwise empty.
   */
  async catalog(category?: string) {
    const rows = await prisma.billService.findMany({
      where: {
        isActive: true,
        ...(category ? { category: category as never } : {}),
      },
      include: { variations: { where: { isActive: true } } },
      orderBy: { name: "asc" },
    });

    const live = useStrowalletLive();

    return Promise.all(
      rows.map(async (svc) => {
        const minAmount =
          svc.category === "ELECTRICITY"
            ? electricityMinNgn(svc.providerCode, svc.id)
            : (BILL_MIN_AMOUNT_NGN[svc.category] ?? 50);

        if (svc.category === "EDUCATION") {
          return {
            ...svc,
            minAmount,
            variations: live ? EDUCATION_PRODUCTS : ([] as CatalogVariation[]),
          };
        }

        if (svc.category === "AIRTIME" || svc.category === "ELECTRICITY" || svc.category === "BETTING") {
          return { ...svc, minAmount, variations: [] as CatalogVariation[] };
        }

        if (!live) {
          // Do not surface seeded 1GB/Compact/etc. demo rows.
          return { ...svc, minAmount, variations: [] as CatalogVariation[] };
        }

        try {
          if (svc.category === "DATA") {
            const plans = normalizeProviderPlans(
              await strowalletClient.getDataPlans(dataServiceId(svc.providerCode ?? svc.id)),
            );
            return { ...svc, minAmount, variations: plans };
          }
          if (svc.category === "CABLE") {
            const plans = normalizeProviderPlans(await strowalletClient.getCablePlans(svc.providerCode ?? svc.id));
            return { ...svc, minAmount, variations: plans };
          }
        } catch (err) {
          console.error(`[bills:catalog] ${svc.category} ${svc.id}`, err);
          return { ...svc, minAmount, variations: [] as CatalogVariation[] };
        }

        return { ...svc, minAmount, variations: [] as CatalogVariation[] };
      }),
    );
  }

  async getService(id: string) {
    return prisma.billService.findUnique({
      where: { id },
      include: { variations: { where: { isActive: true } } },
    });
  }

  /**
   * Admin billers list: DB services (Strowallet codes) + rolling 7d vend stats
   * + live plan counts from Strowallet for DATA/CABLE.
   * Field names keep the `*24h` suffix for admin UI compatibility.
   */
  async adminListServices() {
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [services, stats7d, stats24h, lastVends, catalog] = await Promise.all([
      prisma.billService.findMany({
        orderBy: [{ category: "asc" }, { name: "asc" }],
        include: { _count: { select: { variations: true } } },
      }),
      prisma.billPayment.groupBy({
        by: ["serviceId", "status"],
        where: { createdAt: { gte: since7d } },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      prisma.billPayment.groupBy({
        by: ["serviceId", "status"],
        where: { createdAt: { gte: since24h } },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      prisma.billPayment.groupBy({
        by: ["serviceId"],
        _max: { createdAt: true },
      }),
      this.catalog().catch(() => [] as Awaited<ReturnType<BillsService["catalog"]>>),
    ]);

    const planCountBy = new Map(
      catalog.map((s) => [s.id, Array.isArray(s.variations) ? s.variations.length : 0]),
    );
    const lastBy = new Map(lastVends.map((r) => [r.serviceId, r._max.createdAt]));

    const fold = (rows: typeof stats7d) => {
      const statsBy = new Map<string, { total: number; success: number; value: number }>();
      for (const row of rows) {
        const cur = statsBy.get(row.serviceId) ?? { total: 0, success: 0, value: 0 };
        cur.total += row._count._all;
        if (row.status === "SUCCESS") {
          cur.success += row._count._all;
          cur.value += Number(row._sum.amount ?? 0);
        }
        statsBy.set(row.serviceId, cur);
      }
      return statsBy;
    };
    const by7d = fold(stats7d);
    const by24h = fold(stats24h);

    return services.map(({ _count, isActive, ...s }) => {
      // Prefer 7d for the board (sparse traffic); fall back to lifetime lastVend.
      const st = by7d.get(s.id) ?? { total: 0, success: 0, value: 0 };
      const st24 = by24h.get(s.id) ?? { total: 0, success: 0, value: 0 };
      const successRate = st.total > 0 ? Math.round((st.success / st.total) * 1000) / 10 : null;
      let status: "live" | "degraded" | "disabled" = isActive ? "live" : "disabled";
      // Degrade on recent (24h) pain so an old bad day doesn't keep a route amber.
      const rate24 = st24.total > 0 ? (st24.success / st24.total) * 100 : null;
      if (isActive && st24.total >= 3 && rate24 != null && rate24 < 90) status = "degraded";
      const livePlans = planCountBy.get(s.id);
      return {
        ...s,
        provider: s.provider || "strowallet",
        active: isActive,
        status,
        variationsCount: livePlans ?? _count.variations,
        plansSource:
          s.category === "DATA" || s.category === "CABLE"
            ? useStrowalletLive()
              ? "strowallet"
              : "none"
            : s.category === "AIRTIME" || s.category === "ELECTRICITY" || s.category === "BETTING"
              ? "variable"
              : "none",
        volume24h: st.total,
        success24h: st.success,
        value24h: st.value,
        successRate,
        windowDays: 7,
        lastVend: lastBy.get(s.id)?.toISOString() ?? null,
      };
    });
  }

  /**
   * Admin products: live Strowallet DATA/CABLE plans (not DB seed rows),
   * plus variable-amount placeholders for airtime / electricity / betting.
   */
  async adminListProducts() {
    const [catalog, sold] = await Promise.all([
      this.catalog(),
      prisma.billPayment.groupBy({
        by: ["serviceId", "variationCode"],
        where: {
          createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          status: "SUCCESS",
        },
        _count: { _all: true },
        _sum: { amount: true },
      }),
    ]);

    const soldBy = new Map<string, { count: number; value: number }>();
    for (const row of sold) {
      const key = `${row.serviceId}::${row.variationCode ?? "variable"}`;
      soldBy.set(key, {
        count: row._count._all,
        value: Number(row._sum.amount ?? 0),
      });
    }

    const products: Array<Record<string, unknown>> = [];
    for (const svc of catalog) {
      const variations = Array.isArray(svc.variations) ? svc.variations : [];
      if (variations.length === 0) {
        if (
          svc.category === "AIRTIME" ||
          svc.category === "ELECTRICITY" ||
          svc.category === "BETTING" ||
          svc.category === "EDUCATION"
        ) {
          const key = `${svc.id}::variable`;
          const s = soldBy.get(key) ?? soldBy.get(`${svc.id}::`) ?? { count: 0, value: 0 };
          products.push({
            id: `${svc.id}:variable`,
            code: "variable",
            name: `${svc.name} (any amount)`,
            amount: null,
            isActive: svc.isActive,
            serviceId: svc.id,
            serviceName: svc.name,
            category: svc.category,
            provider: svc.provider || "strowallet",
            serviceActive: svc.isActive,
            source: "strowallet",
            sold24h: s.count,
            value24h: s.value,
            createdAt: svc.createdAt,
          });
        }
        continue;
      }
      for (const v of variations) {
        const key = `${svc.id}::${v.code}`;
        const s = soldBy.get(key) ?? { count: 0, value: 0 };
        products.push({
          id: `${svc.id}:${v.code}`,
          code: v.code,
          name: v.name,
          amount: v.amount,
          isActive: v.isActive !== false,
          serviceId: svc.id,
          serviceName: svc.name,
          category: svc.category,
          provider: svc.provider || "strowallet",
          serviceActive: svc.isActive,
          source: "strowallet",
          sold24h: s.count,
          value24h: s.value,
          createdAt: svc.createdAt,
        });
      }
    }
    return products;
  }

  async verifyMeter(input: z.infer<typeof verifyMeterSchema>) {
    if (!useStrowalletLive()) {
      throw new AppError("Meter verification is temporarily unavailable. Please try again later.", 503, "PROVIDER_UNAVAILABLE");
    }

    const svc = await prisma.billService.findUnique({ where: { id: input.serviceID } });
    const resolvedService = resolveElectricityServiceName(svc?.providerCode, input.serviceID);

    const raw = (await strowalletClient.verifyMeter({
      meter_number: input.billersCode.replace(/\D/g, ""),
      service_name: resolvedService,
      meter_type: input.type,
    })) as Record<string, unknown>;

    let customerName = extractCustomerName(raw)?.trim();
    const address = extractMeterAddress(raw);
    // Strowallet sometimes returns success with name only in nested blobs — if still empty
    // but we have an address (or explicit success), treat as verified so pay can proceed.
    if (!customerName) {
      const successFlag = raw.success;
      if (successFlag === true || address) {
        customerName = address ? `Meter at ${address.slice(0, 48)}` : "Verified customer";
      }
    }
    if (!customerName) {
      throw new AppError(
        "Could not verify this meter. Check the number, prepaid/postpaid type, and disco, then try again.",
        400,
        "METER_NOT_VERIFIED",
      );
    }

    const customerDistrict =
      (typeof raw.customer_district === "string" && raw.customer_district.trim()) ||
      (typeof raw.Customer_District === "string" && raw.Customer_District.trim()) ||
      null;

    return {
      customerName,
      customer_name: customerName,
      address,
      customerDistrict,
      meterNumber: input.billersCode,
      meterType: input.type,
      serviceId: input.serviceID,
      serviceName: resolvedService,
      minAmount: electricityMinNgn(resolvedService, input.serviceID),
      raw,
    };
  }

  async pay(userId: string, input: z.infer<typeof payBillSchema>) {
    await assertKillSwitchOff(KILL_SWITCH_KEYS.BILLS, "Bill payments are temporarily disabled");
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true, email: true },
    });
    const svc = await prisma.billService.findUnique({ where: { id: input.serviceId } });
    const providerCode = svc?.providerCode ?? input.serviceId;

    // Never treat candidate names / meter numbers as the notify phone unless they look like NG mobiles.
    const phone =
      normalizeNgPhone(input.phone) ??
      normalizeNgPhone(user?.phone) ??
      (looksLikeNgPhone(input.customerRef) ? normalizeNgPhone(input.customerRef) : null) ??
      input.phone ??
      input.customerRef;

    if (input.category === "BETTING") {
      throw new AppError("Betting top-up is not available yet", 400, "UNSUPPORTED_BILL");
    }

    const minAmount =
      input.category === "ELECTRICITY"
        ? electricityMinNgn(providerCode, input.serviceId)
        : (BILL_MIN_AMOUNT_NGN[input.category] ?? 50);
    if (input.amount < minAmount) {
      throw new AppError(
        `Minimum amount for this provider is ₦${minAmount.toLocaleString()}`,
        400,
        "MIN_BILL",
      );
    }

    if (input.category === "EDUCATION") {
      const name = input.customerRef.trim();
      if (name.length < 3 || !/[a-zA-Z]/.test(name)) {
        throw new AppError("Enter a valid candidate name", 400, "VALIDATION_ERROR");
      }
      if (!input.variationCode) {
        throw new AppError("Select an education product", 400, "VALIDATION_ERROR");
      }
      if (!normalizeNgPhone(input.phone) && !normalizeNgPhone(user?.phone)) {
        throw new AppError(
          "Add a Nigerian phone number on your profile (or this screen) so we can deliver your PIN",
          400,
          "PHONE_REQUIRED",
        );
      }
    }

    if (!useStrowalletLive()) {
      throw new AppError("Bill payments are temporarily unavailable. Please try again later.", 503, "PROVIDER_UNAVAILABLE");
    }

    const walletTx = await walletService.debit({
      userId,
      currency: input.currency,
      amount: input.amount,
      type: "BILL_PAYMENT",
      description: `${input.category} ${svc?.shortName ?? svc?.name ?? input.serviceId}`,
      provider: "strowallet",
      metadata: asJson({
        category: input.category,
        serviceId: input.serviceId,
        customerRef: input.customerRef,
        variationCode: input.variationCode,
      }),
    });

    try {
      let providerResult: unknown;

      switch (input.category) {
        case "AIRTIME":
          providerResult = await strowalletClient.buyAirtime({
            amount: input.amount,
            phone,
            service_name: airtimeServiceName(providerCode),
          });
          break;
        case "DATA":
          providerResult = await strowalletClient.buyData({
            amount: input.amount,
            phone,
            service_id: dataServiceId(providerCode),
            variation_code: input.variationCode ?? "",
            service_name: input.serviceName ?? input.variationCode ?? undefined,
          });
          break;
        case "ELECTRICITY": {
          const meterType = (input.variationCode === "postpaid" ? "postpaid" : "prepaid") as "prepaid" | "postpaid";
          const notifyPhone =
            normalizeNgPhone(input.phone) ?? normalizeNgPhone(user?.phone);
          if (!notifyPhone) {
            throw new AppError(
              "Add a Nigerian phone number in Profile so we can deliver your electricity token SMS",
              400,
              "PHONE_REQUIRED",
            );
          }
          const elecService = resolveElectricityServiceName(svc?.providerCode, input.serviceId);
          providerResult = await strowalletClient.buyElectricity({
            amount: input.amount,
            phone: notifyPhone,
            service_name: elecService,
            meter_number: input.customerRef.replace(/\D/g, ""),
            meter_type: meterType,
          });
          break;
        }
        case "CABLE":
          providerResult = await strowalletClient.buyCable({
            amount: input.amount,
            phone,
            service_id: providerCode,
            variation_code: input.variationCode ?? "",
            customer_id: input.customerRef,
          });
          break;
        case "EDUCATION": {
          const eduPhone =
            normalizeNgPhone(input.phone) ?? normalizeNgPhone(user?.phone) ?? normalizeNgPhone(phone);
          if (!eduPhone) {
            throw new AppError(
              "Add a Nigerian phone number on your profile so we can deliver your PIN",
              400,
              "PHONE_REQUIRED",
            );
          }
          providerResult = await strowalletClient.buyEducational({
            amount: input.amount,
            phone: eduPhone,
            service_name: providerCode || "waec",
            variation_code: input.variationCode ?? "waecdirect",
          });
          break;
        }
        default:
          throw new AppError(`Unsupported bill category: ${input.category}`, 400, "UNSUPPORTED_BILL");
      }

      const token = extractToken(providerResult);
      const units = extractUnits(providerResult);
      const customerName = extractCustomerName(providerResult);
      // Electricity tokens get dashed formatting; education PINs stay as returned.
      const displayToken =
        token && input.category === "ELECTRICITY" ? formatRechargeToken(token) : token;

      const notifyPhoneStored =
        input.category === "EDUCATION"
          ? normalizeNgPhone(input.phone) ?? normalizeNgPhone(user?.phone) ?? phone
          : phone;

      const payment = await prisma.billPayment.create({
        data: {
          userId,
          transactionId: walletTx.id,
          category: input.category,
          serviceId: input.serviceId,
          customerRef: input.customerRef,
          variationCode: input.variationCode,
          amount: input.amount,
          phone: notifyPhoneStored,
          provider: "strowallet",
          status: "SUCCESS",
          token: displayToken ?? token,
          providerPayload: asJson(providerResult),
        },
      });

      await prisma.transaction.update({
        where: { id: walletTx.id },
        data: {
          status: "SUCCESS",
          metadata: asJson({
            category: input.category,
            serviceId: input.serviceId,
            customerRef: input.customerRef,
            variationCode: input.variationCode,
            token: displayToken ?? token ?? null,
            units: units ?? null,
            customerName: customerName ?? null,
            meterType: input.variationCode ?? null,
          }),
        },
      });

      if (input.category === "EDUCATION" && (displayToken ?? token)) {
        void maybeSendEducationPinEmail({
          userId,
          pin: String(displayToken ?? token),
          productName: svc?.name ?? "Education PIN",
          candidateName: input.customerRef,
          amount: input.amount,
          reference: walletTx.reference,
        });
      }

      return {
        ...payment,
        token: displayToken ?? token ?? payment.token,
        units: units ?? null,
        customerName: customerName ?? null,
        email: user?.email ?? null,
        transaction: { ...walletTx, status: "SUCCESS" },
      };
    } catch (error) {
      await walletService.credit({
        userId,
        currency: input.currency,
        amount: input.amount,
        type: "ADJUSTMENT",
        description: `Refund failed bill ${walletTx.reference}`,
        provider: "strowallet",
      });
      throw error;
    }
  }
}

function looksLikeNgPhone(value?: string | null) {
  return Boolean(normalizeNgPhone(value));
}

/** Local 11-digit NG mobile (0803…) or null. */
function normalizeNgPhone(value?: string | null): string | null {
  if (!value) return null;
  let raw = value.replace(/\D/g, "");
  if (raw.startsWith("234")) raw = raw.slice(3);
  if (raw.length === 10 && !raw.startsWith("0")) raw = `0${raw}`;
  return /^0[789]\d{9}$/.test(raw) ? raw : null;
}

export const billsService = new BillsService();
