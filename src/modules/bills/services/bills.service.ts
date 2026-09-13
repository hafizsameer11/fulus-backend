import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { strowalletClient } from "../../../providers/strowallet/client.js";
import { walletService } from "../../wallet/services/wallet.service.js";
import { useStrowalletLive } from "../../../lib/simulate.js";
import { AppError } from "../../../lib/errors.js";

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

  const candidates: unknown[] = [
    root.token,
    root.Token,
    root.purchased_code,
    root.purchasedCode,
    response?.Token,
    response?.token,
    response?.purchased_code,
    response?.purchasedCode,
    data?.token,
    data?.Token,
    data?.purchased_code,
    transactions?.token,
    transactions?.Token,
    root.message,
    response?.message,
  ];

  for (const c of candidates) {
    if (typeof c === "string") {
      const cleaned = cleanTokenValue(c);
      if (cleaned) return cleaned;
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
  const candidates = [
    root.customer_name,
    root.Customer_Name,
    root.CustomerName,
    response?.CustomerName,
    response?.customer_name,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return undefined;
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
        if (svc.category === "AIRTIME" || svc.category === "ELECTRICITY" || svc.category === "BETTING") {
          return { ...svc, variations: [] as CatalogVariation[] };
        }

        if (!live) {
          // Do not surface seeded 1GB/Compact/etc. demo rows.
          return { ...svc, variations: [] as CatalogVariation[] };
        }

        try {
          if (svc.category === "DATA") {
            const plans = normalizeProviderPlans(
              await strowalletClient.getDataPlans(dataServiceId(svc.providerCode ?? svc.id)),
            );
            return { ...svc, variations: plans };
          }
          if (svc.category === "CABLE") {
            const plans = normalizeProviderPlans(await strowalletClient.getCablePlans(svc.providerCode ?? svc.id));
            return { ...svc, variations: plans };
          }
        } catch (err) {
          console.error(`[bills:catalog] ${svc.category} ${svc.id}`, err);
          return { ...svc, variations: [] as CatalogVariation[] };
        }

        // EDUCATION / OTHER — no seeded amounts
        return { ...svc, variations: [] as CatalogVariation[] };
      }),
    );
  }

  async getService(id: string) {
    return prisma.billService.findUnique({
      where: { id },
      include: { variations: { where: { isActive: true } } },
    });
  }

  async verifyMeter(input: z.infer<typeof verifyMeterSchema>) {
    if (!useStrowalletLive()) {
      throw new AppError("Meter verification is temporarily unavailable. Please try again later.", 503, "PROVIDER_UNAVAILABLE");
    }

    const svc = await prisma.billService.findUnique({ where: { id: input.serviceID } });
    const serviceName = svc?.providerCode ?? input.serviceID;

    const raw = (await strowalletClient.verifyMeter({
      meter_number: input.billersCode,
      service_name: serviceName,
      meter_type: input.type,
    })) as Record<string, unknown>;

    const customerName = extractCustomerName(raw)?.trim();
    if (!customerName) {
      throw new AppError("Could not verify this meter. Check the number and disco, then try again.", 400, "METER_NOT_VERIFIED");
    }

    const address =
      (typeof raw.address === "string" && raw.address.trim()) ||
      (typeof raw.Address === "string" && raw.Address.trim()) ||
      null;
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
      raw,
    };
  }

  async pay(userId: string, input: z.infer<typeof payBillSchema>) {
    const phone = input.phone ?? input.customerRef;
    const svc = await prisma.billService.findUnique({ where: { id: input.serviceId } });
    const providerCode = svc?.providerCode ?? input.serviceId;

    if (input.category === "BETTING") {
      throw new AppError("Betting top-up is not available yet", 400, "UNSUPPORTED_BILL");
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
          // phone must be a mobile number for SMS — never send the meter as phone
          const notifyPhone = looksLikeNgPhone(phone) ? phone : looksLikeNgPhone(input.phone) ? String(input.phone) : phone;
          providerResult = await strowalletClient.buyElectricity({
            amount: input.amount,
            phone: notifyPhone,
            service_name: providerCode,
            meter_number: input.customerRef,
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
        case "EDUCATION":
          providerResult = await strowalletClient.buyEducational({
            amount: input.amount,
            phone,
            service_name: providerCode || "waec",
            variation_code: input.variationCode ?? "waecdirect",
          });
          break;
        default:
          throw new AppError(`Unsupported bill category: ${input.category}`, 400, "UNSUPPORTED_BILL");
      }

      const token = extractToken(providerResult);
      const units = extractUnits(providerResult);
      const customerName = extractCustomerName(providerResult);
      const displayToken = token ? formatRechargeToken(token) : undefined;

      const payment = await prisma.billPayment.create({
        data: {
          userId,
          transactionId: walletTx.id,
          category: input.category,
          serviceId: input.serviceId,
          customerRef: input.customerRef,
          variationCode: input.variationCode,
          amount: input.amount,
          phone,
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

      return {
        ...payment,
        token: displayToken ?? token ?? payment.token,
        units: units ?? null,
        customerName: customerName ?? null,
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
  if (!value) return false;
  let raw = value.replace(/\D/g, "");
  if (raw.startsWith("234")) raw = raw.slice(3);
  if (raw.length === 10 && !raw.startsWith("0")) raw = `0${raw}`;
  return /^0[789]\d{9}$/.test(raw);
}

export const billsService = new BillsService();
