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

const SIM_CATALOGUE = [
  { name: "Europe 1GB 7D", region: "EU", dataMb: 1024, days: 7, priceUsd: 4.5 },
  { name: "Europe 3GB 15D", region: "EU", dataMb: 3072, days: 15, priceUsd: 9.9 },
  { name: "USA 1GB 7D", region: "US", dataMb: 1024, days: 7, priceUsd: 5.5 },
  { name: "USA 5GB 30D", region: "US", dataMb: 5120, days: 30, priceUsd: 16 },
  { name: "Global 1GB 7D", region: "GLOBAL", dataMb: 1024, days: 7, priceUsd: 8 },
  { name: "Nigeria 2GB 14D", region: "NG", dataMb: 2048, days: 14, priceUsd: 6 },
  { name: "Saudi 3GB 15D", region: "SA", dataMb: 3072, days: 15, priceUsd: 7.5 },
];

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export class EsimService {
  async catalogue(query?: Record<string, string>) {
    if (useEsimGoLive()) return esimGoClient.getCatalogue(query);
    const region = query?.region?.toUpperCase();
    const rows = region ? SIM_CATALOGUE.filter((r) => r.region === region) : SIM_CATALOGUE;
    return { bundles: rows, simulated: true };
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
    if (useEsimGoLive()) {
      await esimGoClient.validateOrder({ item: input.bundleName, quantity: input.quantity });
    }

    const walletTx = await walletService.debit({
      userId,
      currency: input.currency,
      amount: input.amount,
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
            label: input.label ?? input.bundleName,
            activationCode,
            dataRemainingMb: 1024,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            qrCodeUrl: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(activationCode)}`,
            providerPayload: asJson({ simulated: true }),
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
            activationCode =
              typeof first.matchingId === "string"
                ? first.matchingId
                : typeof first.activationCode === "string"
                  ? first.activationCode
                  : undefined;
          }
        } catch {
          // Assignment fetch can lag
        }
      }

      return prisma.esim.create({
        data: {
          userId,
          provider: "esim-go",
          iccid,
          status: iccid ? "READY" : "ORDERED",
          bundleName: input.bundleName,
          label: input.label ?? input.bundleName,
          activationCode,
          providerPayload: asJson(providerResult),
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
        amount: input.amount,
        type: "ADJUSTMENT",
        description: `Refund failed eSIM ${walletTx.reference}`,
        provider: "esim-go",
      });
      throw error instanceof Error ? error : new AppError("eSIM purchase failed");
    }
  }

  async topup(userId: string, id: string, input: z.infer<typeof topupSchema>) {
    const esim = await this.get(userId, id);
    const walletTx = await walletService.debit({
      userId,
      currency: input.currency,
      amount: input.amount,
      type: "ESIM_PURCHASE",
      description: `eSIM topup ${input.bundleName}`,
      provider: useEsimGoLive() ? "esim-go" : "simulated",
    });

    const addMb = input.dataMb ?? 1024;
    const updated = await prisma.esim.update({
      where: { id: esim.id },
      data: {
        dataRemainingMb: (esim.dataRemainingMb ?? 0) + addMb,
        status: "INSTALLED",
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        orders: {
          create: {
            transactionId: walletTx.id,
            bundleName: input.bundleName,
            quantity: 1,
            orderReference: simRef("TOP"),
            status: "SUCCESS",
            providerPayload: asJson({ simulated: !useEsimGoLive(), topupMb: addMb }),
          },
        },
      },
      include: { orders: true },
    });

    return { esim: updated, transaction: walletTx };
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
    const total = 2048;
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
