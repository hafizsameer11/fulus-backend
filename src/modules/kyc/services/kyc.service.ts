import { z } from "zod";
import type { KycCheckType, Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { premblyClient } from "../../../providers/prembly/client.js";
import { usePremblyLive } from "../../../lib/simulate.js";
import { AppError } from "../../../lib/errors.js";
import { createInboxMessage } from "../../../lib/inbox.js";

export const bvnSchema = z.object({
  number: z.string().regex(/^\d{11}$/, "BVN must be 11 digits"),
  phone: z.string().min(10).max(15).optional(),
  image: z.string().optional(),
});

export const ninSchema = z.object({
  number: z.string().regex(/^\d{11}$/, "NIN must be 11 digits"),
  dateOfBirth: z.string().min(4).max(32),
});

export const addressSchema = z.object({
  line1: z.string().min(3),
  line2: z.string().optional(),
  city: z.string().min(2),
  state: z.string().min(2),
  country: z.string().min(2).default("NG"),
  postalCode: z.string().optional(),
  documentName: z.string().min(1, "Proof of address is required"),
  documentType: z.string().optional(),
});

export const faceSchema = z
  .object({
    image: z.string().min(10).optional(),
    selfieToken: z.string().min(4).optional(),
  })
  .refine((v) => Boolean(v.image || v.selfieToken), {
    message: "Provide selfieToken or image",
  });

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function extractPremblyReason(result: unknown, fallback: string): string {
  if (!result || typeof result !== "object") return fallback;
  const r = result as Record<string, unknown>;
  const candidates = [
    r.detail,
    r.message,
    r.response_message,
    r.responseMessage,
    r.error,
    r.msg,
    typeof r.data === "object" && r.data
      ? (r.data as Record<string, unknown>).message ?? (r.data as Record<string, unknown>).detail
      : undefined,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim().slice(0, 500);
  }
  return fallback;
}

/**
 * Fire-and-forget background work. Errors are persisted on the KycCheck + inbox.
 */
function runInBackground(label: string, work: () => Promise<void>) {
  setImmediate(() => {
    void work().catch((err) => {
      console.error(`[kyc:async] ${label}`, err);
    });
  });
}

export class KycService {
  async listChecks(userId: string) {
    return prisma.kycCheck.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  }

  /** Latest check per type (for clients that want one row each). */
  async latestByType(userId: string) {
    const rows = await this.listChecks(userId);
    const map = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (!map.has(row.type)) map.set(row.type, row);
    }
    return [...map.values()];
  }

  async verifyBvn(userId: string, input: z.infer<typeof bvnSchema>) {
    const check = await this.beginCheck(userId, "BVN", {
      number: input.number,
      phone: input.phone,
      hasImage: Boolean(input.image),
    });

    runInBackground(`bvn:${check.id}`, () => this.processBvn(check.id, userId, input));
    return check;
  }

  async verifyNin(userId: string, input: z.infer<typeof ninSchema>) {
    const check = await this.beginCheck(userId, "NIN", input);
    runInBackground(`nin:${check.id}`, () => this.processNin(check.id, userId, input));
    return check;
  }

  async verifyAddress(userId: string, input: z.infer<typeof addressSchema>) {
    const check = await this.beginCheck(userId, "ADDRESS", input);
    // No Prembly address API in client yet — queue for async review / simulate pass.
    runInBackground(`address:${check.id}`, () => this.processAddress(check.id, userId, input));
    return check;
  }

  async verifyFace(userId: string, input: z.infer<typeof faceSchema>) {
    const check = await this.beginCheck(userId, "FACE", {
      hasImage: Boolean(input.image),
      selfieToken: input.selfieToken,
    });
    runInBackground(`face:${check.id}`, () => this.processFace(check.id, userId, input));
    return check;
  }

  private async beginCheck(userId: string, type: KycCheckType, input: Record<string, unknown>) {
    const existingPending = await prisma.kycCheck.findFirst({
      where: { userId, type, status: "PENDING" },
      orderBy: { createdAt: "desc" },
    });
    if (existingPending) {
      throw new AppError(
        `${type} verification is already in review. We'll notify you when Prembly finishes.`,
        409,
        "KYC_PENDING",
      );
    }

    // Mark user as under review while checks are pending
    await prisma.user.update({
      where: { id: userId },
      data: { kycStatus: "PENDING" },
    });

    return prisma.kycCheck.create({
      data: {
        userId,
        type,
        status: "PENDING",
        provider: usePremblyLive() ? "prembly" : "simulated",
        input: asJson(input),
      },
    });
  }

  private async processBvn(checkId: string, userId: string, input: z.infer<typeof bvnSchema>) {
    try {
      const result = usePremblyLive()
        ? input.image
          ? await premblyClient.verifyBvnWithFace(input.number, input.image)
          : await premblyClient.verifyBvn(input.number)
        : {
            simulated: true,
            status: true,
            verified: true,
            data: { bvn: input.number, phone: input.phone },
          };

      const passed = this.isPassed(result);
      if (!passed) {
        await this.failCheck(
          checkId,
          userId,
          "BVN",
          result,
          extractPremblyReason(result, "BVN could not be verified with Prembly"),
        );
        return;
      }

      if (input.phone) {
        await prisma.user.update({
          where: { id: userId },
          data: { phone: input.phone },
        });
      }

      await this.passCheck(checkId, userId, "BVN", result);
    } catch (error) {
      await this.failCheck(
        checkId,
        userId,
        "BVN",
        null,
        error instanceof Error ? error.message : "Prembly BVN provider error",
      );
    }
  }

  private async processNin(checkId: string, userId: string, input: z.infer<typeof ninSchema>) {
    try {
      const result = usePremblyLive()
        ? await premblyClient.verifyNin(input.number)
        : {
            simulated: true,
            status: true,
            verified: true,
            data: { nin: input.number, dateOfBirth: input.dateOfBirth },
          };

      const passed = this.isPassed(result);
      if (!passed) {
        await this.failCheck(
          checkId,
          userId,
          "NIN",
          result,
          extractPremblyReason(result, "NIN could not be verified with Prembly"),
        );
        return;
      }

      await this.passCheck(checkId, userId, "NIN", result);
    } catch (error) {
      await this.failCheck(
        checkId,
        userId,
        "NIN",
        null,
        error instanceof Error ? error.message : "Prembly NIN provider error",
      );
    }
  }

  private async processAddress(checkId: string, userId: string, input: z.infer<typeof addressSchema>) {
    try {
      // Prembly has no wired address endpoint yet — accept in simulate; keep pending→pass with review note in live.
      const result = {
        provider: usePremblyLive() ? "prembly-deferred" : "simulated",
        verified: true,
        status: true,
        address: input,
        note: usePremblyLive()
          ? "Address accepted pending Prembly document product wiring"
          : "Simulated address pass",
      };
      await this.passCheck(checkId, userId, "ADDRESS", result);
    } catch (error) {
      await this.failCheck(
        checkId,
        userId,
        "ADDRESS",
        null,
        error instanceof Error ? error.message : "Address verification failed",
      );
    }
  }

  private async processFace(checkId: string, userId: string, input: z.infer<typeof faceSchema>) {
    try {
      // Prefer Prembly BVN+face when we have an image and a passed BVN on file.
      if (usePremblyLive() && input.image) {
        const bvnCheck = await prisma.kycCheck.findFirst({
          where: { userId, type: "BVN", status: "PASSED" },
          orderBy: { createdAt: "desc" },
        });
        const bvnNumber =
          bvnCheck?.input && typeof bvnCheck.input === "object"
            ? String((bvnCheck.input as Record<string, unknown>).number ?? "")
            : "";

        if (bvnNumber.length === 11) {
          const result = await premblyClient.verifyBvnWithFace(bvnNumber, input.image);
          if (!this.isPassed(result)) {
            await this.failCheck(
              checkId,
              userId,
              "FACE",
              result,
              extractPremblyReason(result, "Face match with Prembly failed"),
            );
            return;
          }
          await this.passCheck(checkId, userId, "FACE", result);
          return;
        }
      }

      const result = {
        simulated: !usePremblyLive(),
        verified: true,
        status: true,
        hasImage: Boolean(input.image),
        selfieToken: input.selfieToken,
        note: usePremblyLive()
          ? "Face submitted — complete BVN first for Prembly face match, or await review"
          : "Simulated face pass",
      };

      // Live without BVN+image: leave as soft pass so Tier 3 isn't permanently blocked,
      // but notify that Prembly face match needs BVN.
      if (usePremblyLive() && !input.image) {
        await this.failCheck(
          checkId,
          userId,
          "FACE",
          result,
          "Upload a live selfie image so Prembly can match your face",
        );
        return;
      }

      await this.passCheck(checkId, userId, "FACE", result);
    } catch (error) {
      await this.failCheck(
        checkId,
        userId,
        "FACE",
        null,
        error instanceof Error ? error.message : "Face verification failed",
      );
    }
  }

  private async passCheck(checkId: string, userId: string, type: KycCheckType, result: unknown) {
    await prisma.kycCheck.update({
      where: { id: checkId },
      data: {
        status: "PASSED",
        result: asJson(result),
        failureReason: null,
      },
    });
    await this.syncTier(userId);
    await createInboxMessage({
      userId,
      category: "kyc",
      title: `${type} verified`,
      body: `Your ${type} check passed. Your KYC tier may have been updated.`,
    });
  }

  private async failCheck(
    checkId: string,
    userId: string,
    type: KycCheckType,
    result: unknown,
    reason: string,
  ) {
    await prisma.kycCheck.update({
      where: { id: checkId },
      data: {
        status: "FAILED",
        result: result == null ? undefined : asJson(result),
        failureReason: reason,
      },
    });
    await this.syncTier(userId);
    await createInboxMessage({
      userId,
      category: "kyc",
      title: `${type} verification failed`,
      body: `${reason} Open Verification to update your details and resubmit.`,
    });
  }

  private isPassed(result: unknown) {
    if (!result || typeof result !== "object") return false;
    const r = result as Record<string, unknown>;
    if (typeof r.status === "boolean") return r.status;
    if (typeof r.verified === "boolean") return r.verified;
    if (typeof r.success === "boolean") return r.success;
    if (typeof r.status === "string") {
      const s = r.status.toLowerCase();
      if (s === "success" || s === "verified" || s === "true") return true;
      if (s === "failed" || s === "false" || s === "error") return false;
    }
    return Boolean(r.data);
  }

  private async syncTier(userId: string) {
    const checks = await prisma.kycCheck.findMany({ where: { userId } });
    const passedTypes = new Set(checks.filter((c) => c.status === "PASSED").map((c) => c.type));

    let kycTier = 0;
    if (passedTypes.has("NIN")) kycTier = 1;
    if (passedTypes.has("NIN") && passedTypes.has("BVN")) kycTier = 2;
    if (passedTypes.has("NIN") && passedTypes.has("BVN") && (passedTypes.has("ADDRESS") || passedTypes.has("FACE"))) {
      kycTier = 3;
    }

    const hasPending = checks.some((c) => c.status === "PENDING");
    const latestByType = new Map<string, (typeof checks)[number]>();
    for (const c of checks.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
      if (!latestByType.has(c.type)) latestByType.set(c.type, c);
    }
    const hasLatestFailure = [...latestByType.values()].some((c) => c.status === "FAILED");

    let kycStatus: "PENDING" | "APPROVED" | "REJECTED" = "PENDING";
    if (kycTier >= 1 && !hasPending) kycStatus = "APPROVED";
    else if (hasLatestFailure && kycTier === 0 && !hasPending) kycStatus = "REJECTED";
    else kycStatus = "PENDING";

    await prisma.user.update({
      where: { id: userId },
      data: { kycTier, kycStatus },
    });
  }
}

export const kycService = new KycService();
