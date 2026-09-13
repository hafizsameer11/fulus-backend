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

function extractToken(providerResult: unknown): string | undefined {
  if (!providerResult || typeof providerResult !== "object") return undefined;
  const root = providerResult as Record<string, unknown>;
  const response = root.response && typeof root.response === "object" ? (root.response as Record<string, unknown>) : null;

  const candidates = [
    root.token,
    root.Token,
    root.purchased_code,
    response?.Token,
    response?.purchased_code,
    root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>).token : undefined,
  ];

  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) {
      return c.replace(/^Token\s*:\s*/i, "").trim();
    }
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
      throw new AppError("Meter verification requires a live bill provider", 503, "PROVIDER_UNAVAILABLE");
    }

    const svc = await prisma.billService.findUnique({ where: { id: input.serviceID } });
    const serviceName = svc?.providerCode ?? input.serviceID;

    return strowalletClient.verifyMeter({
      meter_number: input.billersCode,
      service_name: serviceName,
      meter_type: input.type,
    });
  }

  async pay(userId: string, input: z.infer<typeof payBillSchema>) {
    const phone = input.phone ?? input.customerRef;
    const svc = await prisma.billService.findUnique({ where: { id: input.serviceId } });
    const providerCode = svc?.providerCode ?? input.serviceId;

    if (input.category === "BETTING") {
      throw new AppError("Betting top-up is not available via Strowallet yet", 400, "UNSUPPORTED_BILL");
    }

    if (!useStrowalletLive()) {
      throw new AppError("Bill payments require a live provider — demo/seed checkout is disabled", 503, "PROVIDER_UNAVAILABLE");
    }

    const walletTx = await walletService.debit({
      userId,
      currency: input.currency,
      amount: input.amount,
      type: "BILL_PAYMENT",
      description: `${input.category} ${input.serviceId}`,
      provider: "strowallet",
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
          });
          break;
        case "ELECTRICITY":
          providerResult = await strowalletClient.buyElectricity({
            amount: input.amount,
            phone,
            service_name: providerCode,
            meter_number: input.customerRef,
            meter_type: (input.variationCode as "prepaid" | "postpaid") ?? "prepaid",
          });
          break;
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
          token,
          providerPayload: asJson(providerResult),
        },
      });

      return { ...payment, transaction: walletTx };
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

export const billsService = new BillsService();
