import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { strowalletClient } from "../../../providers/strowallet/client.js";
import { walletService } from "../../wallet/services/wallet.service.js";
import { simRef, useStrowalletLive } from "../../../lib/simulate.js";

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
    if (!useStrowalletLive()) {
      return {
        simulated: true,
        Customer_Name: "DEMO CUSTOMER",
        Address: "1 Admiralty Way, Lagos",
        Meter_Number: input.billersCode,
        Min_Purchase_Amount: 500,
        Customer_District: "Ikeja",
      };
    }
    return strowalletClient.verifyMeter(input);
  }

  async pay(userId: string, input: z.infer<typeof payBillSchema>) {
    const phone = input.phone ?? input.customerRef;

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
          input.category === "ELECTRICITY"
            ? `${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}`
            : input.category === "EDUCATION"
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
              service_id: input.serviceId,
            });
            break;
          case "DATA":
            providerResult = await strowalletClient.buyData({
              amount: input.amount,
              phone,
              service_id: input.serviceId,
              variation_code: input.variationCode ?? "",
            });
            break;
          case "ELECTRICITY":
            providerResult = await strowalletClient.buyElectricity({
              amount: input.amount,
              phone,
              serviceID: input.serviceId,
              variation_code: (input.variationCode as "prepaid" | "postpaid") ?? "prepaid",
              billersCode: input.customerRef,
            });
            break;
          case "CABLE":
            providerResult = await strowalletClient.buyCable({
              amount: input.amount,
              phone,
              serviceID: input.serviceId,
              variation_code: input.variationCode ?? "",
              billersCode: input.customerRef,
            });
            break;
          default:
            providerResult = await strowalletClient.buyAirtime({
              amount: input.amount,
              phone,
              service_id: input.serviceId,
            });
        }

        token =
          providerResult &&
          typeof providerResult === "object" &&
          "data" in providerResult &&
          providerResult.data &&
          typeof providerResult.data === "object" &&
          "token" in (providerResult.data as object)
            ? String((providerResult.data as { token: unknown }).token)
            : undefined;
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
