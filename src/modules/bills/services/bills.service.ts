import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { strowalletClient } from "../../../providers/strowallet/client.js";
import { walletService } from "../../wallet/services/wallet.service.js";
import { simRef, useStrowalletLive } from "../../../lib/simulate.js";
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

export class BillsService {
  async list(userId: string) {
    return prisma.billPayment.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  }

  async catalog(category?: string) {
    return prisma.billService.findMany({
      where: {
        isActive: true,
        ...(category ? { category: category as never } : {}),
      },
      include: { variations: { where: { isActive: true } } },
      orderBy: { name: "asc" },
    });
  }

  async getService(id: string) {
    return prisma.billService.findUnique({
      where: { id },
      include: { variations: { where: { isActive: true } } },
    });
  }

  async verifyMeter(input: z.infer<typeof verifyMeterSchema>) {
    const svc = await prisma.billService.findUnique({ where: { id: input.serviceID } });
    const serviceName = svc?.providerCode ?? input.serviceID;

    if (!useStrowalletLive()) {
      return {
        simulated: true,
        customer_name: "DEMO CUSTOMER",
        address: "1 Admiralty Way, Lagos",
        meter_number: input.billersCode,
        Customer_Name: "DEMO CUSTOMER",
        Address: "1 Admiralty Way, Lagos",
        Meter_Number: input.billersCode,
        Min_Purchase_Amount: 500,
        Customer_District: "Ikeja",
      };
    }

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

    const walletTx = await walletService.debit({
      userId,
      currency: input.currency,
      amount: input.amount,
      type: "BILL_PAYMENT",
      description: `${input.category} ${input.serviceId}`,
      provider: useStrowalletLive() ? "strowallet" : "simulated",
    });

    try {
      let providerResult: unknown;
      let token: string | undefined;

      if (!useStrowalletLive()) {
        token =
          input.category === "ELECTRICITY" || input.category === "EDUCATION"
            ? `${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}`
            : undefined;
        providerResult = {
          simulated: true,
          reference: simRef("BILL"),
          status: "success",
          data: { token },
        };
      } else {
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

        token = extractToken(providerResult);
      }

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
          provider: useStrowalletLive() ? "strowallet" : "simulated",
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
