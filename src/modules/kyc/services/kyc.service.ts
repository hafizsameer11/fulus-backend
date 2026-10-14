import { z } from "zod";
import type { KycCheckType, Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { premblyClient } from "../../../providers/prembly/client.js";
import { usePremblyLive } from "../../../lib/simulate.js";
import { AppError, NotFoundError } from "../../../lib/errors.js";
import { createInboxMessage } from "../../../lib/inbox.js";
import { bushaCustomerService } from "../../busha/services/busha-customer.service.js";
import { readKycEvidenceBase64, saveKycEvidence } from "../../../lib/kyc-evidence.js";

export const bvnSchema = z.object({
  number: z.string().regex(/^\d{11}$/, "BVN must be 11 digits"),
  phone: z.string().min(10).max(15).optional(),
  image: z.string().optional(),
});

export const ninSchema = z.object({
  number: z.string().regex(/^\d{11}$/, "NIN must be 11 digits"),
  dateOfBirth: z.string().min(4).max(32),
  /** Nigerian mobile — saved on the profile for Busha KYC / delivery. */
  phone: z.string().min(10, "Enter your phone number").max(15),
  /** Base64 or data-URL selfie — required for Prembly NIN+face + Busha KYC */
  image: z.string().min(40, "Selfie image is required"),
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
  /** Base64 or data-URL of the uploaded proof — required for real review. */
  documentImage: z.string().min(40, "Upload a proof-of-address image"),
});

export const faceSchema = z.object({
  /** Base64 or data-URL selfie — required (no token-only pass). */
  image: z.string().min(40, "Selfie image is required"),
  selfieToken: z.string().min(4).optional(),
});

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function extractPremblyReason(result: unknown, fallback: string): string {
  if (!result || typeof result !== "object") return fallback;
  const r = result as Record<string, unknown>;
  const face = r.face_data && typeof r.face_data === "object" ? (r.face_data as Record<string, unknown>) : null;
  const candidates = [
    face?.message,
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
async function persistEvidence(
  checkId: string,
  kind: "selfie" | "document",
  image?: string,
): Promise<string | undefined> {
  if (!image || image.length < 40) return undefined;
  try {
    return await saveKycEvidence(checkId, kind, image);
  } catch (err) {
    console.error(`[kyc:evidence] ${checkId}/${kind}`, err);
    return undefined;
  }
}

async function mergeEvidencePaths(checkId: string, paths: Record<string, string | undefined>) {
  const check = await prisma.kycCheck.findUnique({ where: { id: checkId } });
  if (!check) return;
  const prev =
    check.result && typeof check.result === "object" ? (check.result as Record<string, unknown>) : {};
  const existing =
    prev.evidencePaths && typeof prev.evidencePaths === "object"
      ? (prev.evidencePaths as Record<string, string>)
      : {};
  const evidencePaths = { ...existing, ...Object.fromEntries(Object.entries(paths).filter(([, v]) => v)) };
  await prisma.kycCheck.update({
    where: { id: checkId },
    data: { result: asJson({ ...prev, evidencePaths }) },
  });
}

function runInBackground(label: string, work: () => Promise<void>) {
  setImmediate(() => {
    void work().catch((err) => {
      console.error(`[kyc:async] ${label}`, err);
    });
  });
}

/** True when the user has a real NG mobile on their profile (not empty / placeholder). */
export function hasUsablePhone(phone?: string | null): boolean {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.length < 10) return false;
  // Block the legacy Busha placeholder (+234 8010000000) and obvious fakes.
  const national = digits.startsWith("234") ? digits.slice(3) : digits.replace(/^0/, "");
  if (!national || /^0+$/.test(national)) return false;
  if (national === "8010000000" || national.startsWith("801000000")) return false;
  return true;
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

  /** KYC steps require a phone on the profile first (Busha rejects placeholder numbers). */
  private async assertPhoneForKyc(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true },
    });
    if (!hasUsablePhone(user?.phone)) {
      throw new AppError(
        "Add your phone number in Profile before starting verification.",
        400,
        "PHONE_REQUIRED",
      );
    }
  }

  async verifyBvn(userId: string, input: z.infer<typeof bvnSchema>) {
    await this.assertPhoneForKyc(userId);
    const check = await this.beginCheck(userId, "BVN", {
      number: input.number,
      phone: input.phone,
      hasImage: Boolean(input.image),
    });

    runInBackground(`bvn:${check.id}`, () => this.processBvn(check.id, userId, input));
    return check;
  }

  async verifyNin(userId: string, input: z.infer<typeof ninSchema>) {
    if (!hasUsablePhone(input.phone)) {
      throw new AppError(
        "Enter a valid Nigerian phone number (e.g. 08012345678).",
        400,
        "PHONE_REQUIRED",
      );
    }
    // Persist phone before Prembly/Busha so crypto KYC has a real number.
    await prisma.user.update({
      where: { id: userId },
      data: { phone: input.phone.replace(/\D/g, "").slice(0, 15) },
    });
    // Do not persist raw selfie bytes in DB input — keep metadata only.
    const check = await this.beginCheck(userId, "NIN", {
      number: input.number,
      dateOfBirth: input.dateOfBirth,
      phone: input.phone,
      hasImage: true,
    });
    // Mirror selfie step as FACE pending so crypto / profile can show under-review.
    await this.beginCheckQuiet(userId, "FACE", { hasImage: true, source: "nin" });

    runInBackground(`nin:${check.id}`, () => this.processNin(check.id, userId, input));
    return check;
  }

  async verifyAddress(userId: string, input: z.infer<typeof addressSchema>) {
    await this.assertPhoneForKyc(userId);
    const { documentImage, ...meta } = input;
    const check = await this.beginCheck(userId, "ADDRESS", {
      ...meta,
      hasDocumentImage: Boolean(documentImage && documentImage.length > 40),
    });
    runInBackground(`address:${check.id}`, () => this.processAddress(check.id, userId, input));
    return check;
  }

  async verifyFace(userId: string, input: z.infer<typeof faceSchema>) {
    await this.assertPhoneForKyc(userId);
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

  /** Same as beginCheck but skip if already pending (used for paired FACE row). */
  private async beginCheckQuiet(userId: string, type: KycCheckType, input: Record<string, unknown>) {
    const existingPending = await prisma.kycCheck.findFirst({
      where: { userId, type, status: "PENDING" },
      orderBy: { createdAt: "desc" },
    });
    if (existingPending) return existingPending;

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
      if (input.image) {
        const path = await persistEvidence(checkId, "selfie", input.image);
        await mergeEvidencePaths(checkId, { selfie: path });
      }
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
      const selfiePath = await persistEvidence(checkId, "selfie", input.image);
      await mergeEvidencePaths(checkId, { selfie: selfiePath });
      const result = usePremblyLive()
        ? await premblyClient.verifyNinWithFace(input.number, input.image, input.dateOfBirth)
        : {
            simulated: true,
            status: true,
            verified: true,
            face_data: { status: true, message: "Face Match", confidence: 99 },
            nin_data: { nin: input.number, birthdate: input.dateOfBirth },
          };

      const passed = this.isPassed(result) && this.faceMatched(result);
      if (!passed) {
        await this.failCheck(
          checkId,
          userId,
          "NIN",
          result,
          extractPremblyReason(result, "NIN or selfie could not be verified with Prembly"),
        );
        await this.failLatestPending(userId, "FACE", result, "Selfie did not match NIN records");
        return;
      }

      await prisma.user.update({
        where: { id: userId },
        data: {
          nin: input.number,
          dateOfBirth: input.dateOfBirth,
          ...(hasUsablePhone(input.phone)
            ? { phone: input.phone.replace(/\D/g, "").slice(0, 15) }
            : {}),
        },
      });

      await this.passCheck(checkId, userId, "NIN", result);
      await this.passLatestPendingOrCreate(userId, "FACE", result);

      // Prembly approved → create Busha customer + submit KYC with NIN + DOB + selfie.
      // Fulus kycStatus stays PENDING until Busha returns active (see syncTier).
      try {
        await bushaCustomerService.createFromNinKyc({
          userId,
          nin: input.number,
          dateOfBirth: input.dateOfBirth,
          selfieImage: input.image,
          premblyResult: result,
        });
        await this.syncTier(userId);
      } catch (err) {
        console.error("[kyc] busha customer create failed", err);
        await this.syncTier(userId);
        await createInboxMessage({
          userId,
          category: "kyc",
          title: "Crypto KYC pending",
          body:
            err instanceof Error
              ? `NIN passed, but crypto profile setup failed: ${err.message}`
              : "NIN passed, but crypto profile setup failed. Support will retry.",
        });
      }
    } catch (error) {
      await this.failCheck(
        checkId,
        userId,
        "NIN",
        null,
        error instanceof Error ? error.message : "Prembly NIN provider error",
      );
      await this.failLatestPending(
        userId,
        "FACE",
        null,
        error instanceof Error ? error.message : "Face verification failed with NIN",
      );
    }
  }

  private async processAddress(checkId: string, userId: string, input: z.infer<typeof addressSchema>) {
    try {
      if (!input.documentImage || input.documentImage.length < 40) {
        await this.failCheck(checkId, userId, "ADDRESS", null, "Proof of address image is required");
        return;
      }
      const docPath = await persistEvidence(checkId, "document", input.documentImage);
      await mergeEvidencePaths(checkId, { document: docPath });
      // Never auto-pass ADDRESS — stay PENDING for admin review (compliance).
      const result = {
        provider: usePremblyLive() ? "prembly-deferred" : "manual-review",
        verified: false,
        status: false,
        address: {
          line1: input.line1,
          line2: input.line2,
          city: input.city,
          state: input.state,
          country: input.country,
          postalCode: input.postalCode,
          documentName: input.documentName,
          documentType: input.documentType,
          hasDocumentImage: true,
        },
        note: "Awaiting compliance review of proof of address",
      };
      const pendingRow = await prisma.kycCheck.findUnique({ where: { id: checkId } });
      const pendingPrev =
        pendingRow?.result && typeof pendingRow.result === "object"
          ? (pendingRow.result as Record<string, unknown>)
          : {};
      const evidencePaths =
        pendingPrev.evidencePaths && typeof pendingPrev.evidencePaths === "object"
          ? pendingPrev.evidencePaths
          : undefined;
      await prisma.kycCheck.update({
        where: { id: checkId },
        data: {
          status: "PENDING",
          result: asJson({
            ...result,
            ...(evidencePaths ? { evidencePaths } : {}),
          }),
          failureReason: null,
        },
      });
      await createInboxMessage({
        userId,
        category: "kyc",
        title: "Address under review",
        body: "We received your proof of address. Compliance will review it before Tier upgrades.",
      });
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
      if (!input.image || input.image.length < 40) {
        await this.failCheck(checkId, userId, "FACE", null, "Upload a live selfie image");
        return;
      }
      const selfiePath = await persistEvidence(checkId, "selfie", input.image);
      await mergeEvidencePaths(checkId, { selfie: selfiePath });

      if (usePremblyLive()) {
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

        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (user?.nin && user.nin.length === 11) {
          const result = await premblyClient.verifyNinWithFace(user.nin, input.image, user.dateOfBirth ?? undefined);
          if (!this.isPassed(result) || !this.faceMatched(result)) {
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

        await this.failCheck(
          checkId,
          userId,
          "FACE",
          { hasImage: true },
          "Complete BVN or NIN first so Prembly can match your face",
        );
        return;
      }

      // Simulate mode: pass only when a real image was provided (no token-only shortcut).
      await this.passCheck(checkId, userId, "FACE", {
        simulated: true,
        verified: true,
        status: true,
        hasImage: true,
        note: "Simulated face pass with uploaded selfie",
      });
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

  async adminApproveCheck(checkId: string, reviewer: string) {
    const check = await prisma.kycCheck.findUnique({ where: { id: checkId } });
    if (!check) throw new AppError("KYC check not found", 404, "NOT_FOUND");
    if (check.status === "PASSED") return { check };
    const prev =
      check.result && typeof check.result === "object" ? (check.result as Record<string, unknown>) : {};
    await this.passCheck(check.id, check.userId, check.type, {
      ...prev,
      adminApprovedBy: reviewer,
      adminApprovedAt: new Date().toISOString(),
    });
    const updated = await prisma.kycCheck.findUniqueOrThrow({ where: { id: checkId } });
    return { check: updated };
  }

  async adminGetEvidence(checkId: string) {
    const check = await prisma.kycCheck.findUnique({ where: { id: checkId } });
    if (!check) throw new NotFoundError("KYC check not found");

    /** Selfie/ID may live on a sibling NIN/FACE row for the same user — merge all. */
    const siblings = await prisma.kycCheck.findMany({
      where: { userId: check.userId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    const paths: Record<string, string> = {};
    const steps: Array<{
      checkId: string;
      type: string;
      status: string;
      failureReason: string | null;
      at: string;
    }> = [];

    for (const row of siblings) {
      steps.push({
        checkId: row.id,
        type: row.type,
        status: row.status,
        failureReason: row.failureReason,
        at: row.createdAt.toISOString(),
      });
      const result =
        row.result && typeof row.result === "object" ? (row.result as Record<string, unknown>) : {};
      const rowPaths =
        result.evidencePaths && typeof result.evidencePaths === "object"
          ? (result.evidencePaths as Record<string, string>)
          : {};
      for (const [kind, relPath] of Object.entries(rowPaths)) {
        if (relPath && !paths[kind]) paths[kind] = relPath;
      }
    }

    const files: Array<{ kind: string; path: string; mime: string; base64: string }> = [];
    for (const [kind, relPath] of Object.entries(paths)) {
      if (!relPath) continue;
      try {
        const { mime, base64 } = await readKycEvidenceBase64(relPath);
        files.push({ kind, path: relPath, mime, base64 });
      } catch (err) {
        console.error(`[kyc:evidence] read ${relPath}`, err);
      }
    }
    return {
      checkId: check.id,
      userId: check.userId,
      type: check.type,
      status: check.status,
      failureReason: check.failureReason,
      evidencePaths: paths,
      files,
      steps,
    };
  }

  async adminRejectCheck(checkId: string, reason: string, reviewer: string) {
    const check = await prisma.kycCheck.findUnique({ where: { id: checkId } });
    if (!check) throw new AppError("KYC check not found", 404, "NOT_FOUND");
    await this.failCheck(check.id, check.userId, check.type, {
      adminRejectedBy: reviewer,
      adminRejectedAt: new Date().toISOString(),
    }, reason);
    const updated = await prisma.kycCheck.findUniqueOrThrow({ where: { id: checkId } });
    return { check: updated };
  }

  private async passLatestPendingOrCreate(userId: string, type: KycCheckType, result: unknown) {
    const pending = await prisma.kycCheck.findFirst({
      where: { userId, type, status: "PENDING" },
      orderBy: { createdAt: "desc" },
    });
    if (pending) {
      await this.passCheck(pending.id, userId, type, result);
      return;
    }
    const created = await prisma.kycCheck.create({
      data: {
        userId,
        type,
        status: "PASSED",
        provider: usePremblyLive() ? "prembly" : "simulated",
        input: asJson({ source: "nin" }),
        result: asJson(result),
      },
    });
    await this.syncTier(userId);
    void created;
  }

  private async failLatestPending(userId: string, type: KycCheckType, result: unknown, reason: string) {
    const pending = await prisma.kycCheck.findFirst({
      where: { userId, type, status: "PENDING" },
      orderBy: { createdAt: "desc" },
    });
    if (!pending) return;
    await this.failCheck(pending.id, userId, type, result, reason);
  }

  private async mergeResultPreservingEvidence(
    checkId: string,
    result: unknown,
  ): Promise<Prisma.InputJsonValue> {
    const row = await prisma.kycCheck.findUnique({ where: { id: checkId } });
    const prev =
      row?.result && typeof row.result === "object" ? (row.result as Record<string, unknown>) : {};
    const evidencePaths =
      prev.evidencePaths && typeof prev.evidencePaths === "object" ? prev.evidencePaths : undefined;
    const next =
      result && typeof result === "object" && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : { value: result };
    return asJson({
      ...next,
      ...(evidencePaths ? { evidencePaths } : {}),
    });
  }

  private async passCheck(checkId: string, userId: string, type: KycCheckType, result: unknown) {
    await prisma.kycCheck.update({
      where: { id: checkId },
      data: {
        status: "PASSED",
        result: await this.mergeResultPreservingEvidence(checkId, result),
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
        result:
          result == null ? await this.mergeResultPreservingEvidence(checkId, {}) : await this.mergeResultPreservingEvidence(checkId, result),
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

  private faceMatched(result: unknown) {
    if (!result || typeof result !== "object") return true;
    const r = result as Record<string, unknown>;
    const face = r.face_data;
    if (!face || typeof face !== "object") return true;
    const f = face as Record<string, unknown>;
    if (typeof f.status === "boolean") return f.status;
    if (typeof f.status === "string") {
      const s = f.status.toLowerCase();
      return s === "true" || s === "success" || s === "matched" || s === "face match";
    }
    return true;
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
    return Boolean(r.data || r.nin_data);
  }

  /**
   * Tier follows Prembly checks; overall kycStatus is APPROVED only when Busha is active.
   * Prembly-only success must not unlock the app as fully verified.
   */
  async syncTier(userId: string) {
    const [checks, user] = await Promise.all([
      prisma.kycCheck.findMany({ where: { userId } }),
      prisma.user.findUnique({
        where: { id: userId },
        select: { bushaCustomerStatus: true },
      }),
    ]);
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
    const bushaStatus = String(user?.bushaCustomerStatus ?? "").toLowerCase();
    const bushaActive = bushaStatus === "active";
    const bushaRejected = bushaStatus === "rejected";

    let kycStatus: "PENDING" | "APPROVED" | "REJECTED" = "PENDING";
    if (bushaActive && kycTier >= 1 && !hasPending) kycStatus = "APPROVED";
    else if (bushaRejected && !hasPending) kycStatus = "REJECTED";
    else if (hasLatestFailure && kycTier === 0 && !hasPending) kycStatus = "REJECTED";
    else kycStatus = "PENDING";

    await prisma.user.update({
      where: { id: userId },
      data: { kycTier, kycStatus },
    });
  }
}

export const kycService = new KycService();
