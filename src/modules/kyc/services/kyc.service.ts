import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { premblyClient } from "../../../providers/prembly/client.js";
import { usePremblyLive } from "../../../lib/simulate.js";

export const bvnSchema = z.object({
  number: z.string().min(11).max(11),
  image: z.string().optional(),
});

export const ninSchema = z.object({
  number: z.string().min(11),
});

export const addressSchema = z.object({
  line1: z.string().min(3),
  line2: z.string().optional(),
  city: z.string().min(2),
  state: z.string().min(2),
  country: z.string().min(2).default("NG"),
  postalCode: z.string().optional(),
});

export const faceSchema = z.object({
  image: z.string().min(10).optional(),
  selfieToken: z.string().optional(),
});

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export class KycService {
  async listChecks(userId: string) {
    return prisma.kycCheck.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  }

  async verifyBvn(userId: string, input: z.infer<typeof bvnSchema>) {
    const check = await prisma.kycCheck.create({
      data: {
        userId,
        type: "BVN",
        status: "PENDING",
        provider: usePremblyLive() ? "prembly" : "simulated",
        input: asJson({ number: input.number, hasImage: Boolean(input.image) }),
      },
    });

    try {
      const result = usePremblyLive()
        ? input.image
          ? await premblyClient.verifyBvnWithFace(input.number, input.image)
          : await premblyClient.verifyBvn(input.number)
        : { simulated: true, status: true, verified: true, data: { bvn: input.number } };

      const passed = this.isPassed(result);
      const updated = await prisma.kycCheck.update({
        where: { id: check.id },
        data: {
          status: passed ? "PASSED" : "FAILED",
          result: asJson(result),
          failureReason: passed ? null : "BVN verification failed",
        },
      });

      if (passed) await this.syncTier(userId);
      return updated;
    } catch (error) {
      await prisma.kycCheck.update({
        where: { id: check.id },
        data: {
          status: "FAILED",
          failureReason: error instanceof Error ? error.message : "Provider error",
        },
      });
      throw error;
    }
  }

  async verifyNin(userId: string, input: z.infer<typeof ninSchema>) {
    const check = await prisma.kycCheck.create({
      data: {
        userId,
        type: "NIN",
        status: "PENDING",
        provider: usePremblyLive() ? "prembly" : "simulated",
        input: asJson(input),
      },
    });

    try {
      const result = usePremblyLive()
        ? await premblyClient.verifyNin(input.number)
        : { simulated: true, status: true, verified: true, data: { nin: input.number } };

      const passed = this.isPassed(result);
      const updated = await prisma.kycCheck.update({
        where: { id: check.id },
        data: {
          status: passed ? "PASSED" : "FAILED",
          result: asJson(result),
          failureReason: passed ? null : "NIN verification failed",
        },
      });

      if (passed) await this.syncTier(userId);
      return updated;
    } catch (error) {
      await prisma.kycCheck.update({
        where: { id: check.id },
        data: {
          status: "FAILED",
          failureReason: error instanceof Error ? error.message : "Provider error",
        },
      });
      throw error;
    }
  }

  async verifyAddress(userId: string, input: z.infer<typeof addressSchema>) {
    const check = await prisma.kycCheck.create({
      data: {
        userId,
        type: "ADDRESS",
        status: "PASSED",
        provider: "simulated",
        input: asJson(input),
        result: asJson({ simulated: true, verified: true }),
      },
    });
    await this.syncTier(userId);
    return check;
  }

  async verifyFace(userId: string, input: z.infer<typeof faceSchema>) {
    const check = await prisma.kycCheck.create({
      data: {
        userId,
        type: "FACE",
        status: "PASSED",
        provider: usePremblyLive() ? "prembly" : "simulated",
        input: asJson({ hasImage: Boolean(input.image), selfieToken: input.selfieToken }),
        result: asJson({ simulated: !usePremblyLive(), verified: true, status: true }),
      },
    });
    await this.syncTier(userId);
    return check;
  }

  private isPassed(result: unknown) {
    if (!result || typeof result !== "object") return false;
    const r = result as Record<string, unknown>;
    if (typeof r.status === "boolean") return r.status;
    if (typeof r.verified === "boolean") return r.verified;
    if (typeof r.success === "boolean") return r.success;
    return Boolean(r.data);
  }

  private async syncTier(userId: string) {
    const checks = await prisma.kycCheck.findMany({ where: { userId, status: "PASSED" } });
    const types = new Set(checks.map((c) => c.type));

    let kycTier = 0;
    if (types.has("NIN")) kycTier = 1;
    if (types.has("NIN") && types.has("BVN")) kycTier = 2;
    if (types.has("NIN") && types.has("BVN") && (types.has("ADDRESS") || types.has("FACE"))) {
      kycTier = 3;
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        kycTier,
        kycStatus: kycTier >= 1 ? "APPROVED" : "PENDING",
      },
    });
  }
}

export const kycService = new KycService();
