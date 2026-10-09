import bcrypt from "bcryptjs";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "../../../lib/errors.js";
import { prisma } from "../../../lib/prisma.js";
import {
  formatSecret,
  generateBackupCodes,
  generateTotpSecret,
  otpauthUri,
  verifyTotp,
} from "../../../lib/totp.js";

async function audit(actor: string, action: string, detail: string, meta?: Record<string, string>) {
  await prisma.adminAuditLog.create({
    data: { actor, action, subjectId: null, detail, meta: meta ?? undefined },
  });
}

function parseHashes(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function hashCodes(codes: string[]) {
  return Promise.all(codes.map((c) => bcrypt.hash(c.replace(/\s/g, "").toUpperCase(), 10)));
}

async function consumeBackupCode(adminId: string, hashes: string[], code: string): Promise<boolean> {
  const normalized = code.replace(/\s/g, "").toUpperCase();
  for (let i = 0; i < hashes.length; i++) {
    const ok = await bcrypt.compare(normalized, hashes[i]!);
    if (!ok) continue;
    const next = hashes.filter((_, idx) => idx !== i);
    await prisma.adminUser.update({
      where: { id: adminId },
      data: {
        totpBackupHashes: JSON.stringify(next),
        totpLastUsedAt: new Date(),
      },
    });
    return true;
  }
  return false;
}

export class AdminMfaService {
  status(adminId: string) {
    return prisma.adminUser
      .findUnique({
        where: { id: adminId },
        select: {
          totpEnabled: true,
          totpEnrolledAt: true,
          totpLastUsedAt: true,
          totpPendingSecret: true,
          email: true,
        },
      })
      .then((row) => {
        if (!row) throw new NotFoundError("Staff not found");
        return {
          enabled: row.totpEnabled,
          enrolledAt: row.totpEnrolledAt?.toISOString() ?? null,
          lastUsedAt: row.totpLastUsedAt?.toISOString() ?? null,
          setupInProgress: Boolean(row.totpPendingSecret) && !row.totpEnabled,
          email: row.email,
        };
      });
  }

  async beginSetup(adminId: string, actor: string) {
    const secret = generateTotpSecret();
    const admin = await prisma.adminUser.update({
      where: { id: adminId },
      data: { totpPendingSecret: secret },
      select: { email: true },
    });
    await audit(actor, "auth.mfa.setup_begin", "Started authenticator enrolment", { adminId: String(adminId) });
    return {
      secret: formatSecret(secret),
      secretRaw: secret,
      otpauthUrl: otpauthUri({ email: admin.email, secret }),
      issuer: "Fulus Admin",
    };
  }

  async confirmSetup(adminId: string, code: string, actor: string) {
    const admin = await prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin) throw new NotFoundError("Staff not found");
    const pending = admin.totpPendingSecret;
    if (!pending) throw new UnauthorizedError("Start authenticator set-up first");
    if (!verifyTotp(pending, code)) {
      throw new UnauthorizedError("Invalid authenticator code");
    }
    const backups = generateBackupCodes(8);
    const hashes = await hashCodes(backups);
    await prisma.adminUser.update({
      where: { id: adminId },
      data: {
        totpSecret: pending,
        totpPendingSecret: null,
        totpEnabled: true,
        totpBackupHashes: JSON.stringify(hashes),
        totpEnrolledAt: new Date(),
        totpLastUsedAt: new Date(),
      },
    });
    await audit(actor, "auth.mfa.enable", "Authenticator enabled", { adminId });
    return { enabled: true, backupCodes: backups };
  }

  async disable(adminId: string, code: string, actor: string) {
    const admin = await prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin) throw new NotFoundError("Staff not found");
    if (!admin.totpEnabled || !admin.totpSecret) {
      throw new UnauthorizedError("Authenticator is not enabled");
    }
    const totpOk = verifyTotp(admin.totpSecret, code);
    const backupOk = totpOk
      ? false
      : await consumeBackupCode(adminId, parseHashes(admin.totpBackupHashes), code);
    if (!totpOk && !backupOk) {
      throw new UnauthorizedError("Invalid authenticator or backup code");
    }
    await prisma.adminUser.update({
      where: { id: adminId },
      data: {
        totpSecret: null,
        totpPendingSecret: null,
        totpEnabled: false,
        totpBackupHashes: null,
        totpEnrolledAt: null,
        totpLastUsedAt: null,
      },
    });
    await audit(actor, "auth.mfa.disable", "Authenticator disabled", { adminId });
    return { enabled: false };
  }

  async regenerateBackupCodes(adminId: string, code: string, actor: string) {
    const admin = await prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin?.totpEnabled || !admin.totpSecret) {
      throw new UnauthorizedError("Authenticator is not enabled");
    }
    if (!verifyTotp(admin.totpSecret, code)) {
      throw new UnauthorizedError("Invalid authenticator code");
    }
    const backups = generateBackupCodes(8);
    const hashes = await hashCodes(backups);
    await prisma.adminUser.update({
      where: { id: adminId },
      data: {
        totpBackupHashes: JSON.stringify(hashes),
        totpLastUsedAt: new Date(),
      },
    });
    await audit(actor, "auth.mfa.recovery_regen", "Recovery codes regenerated", { adminId });
    return { backupCodes: backups };
  }

  /** Verify login challenge for an enrolled admin. */
  async verifyLogin(adminId: string, code: string) {
    const admin = await prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin || !admin.active) throw new UnauthorizedError("Sign in required");
    if (!admin.totpEnabled || !admin.totpSecret) {
      throw new UnauthorizedError("Authenticator is not enabled for this account");
    }
    if (verifyTotp(admin.totpSecret, code)) {
      await prisma.adminUser.update({
        where: { id: adminId },
        data: { totpLastUsedAt: new Date() },
      });
      return true;
    }
    const used = await consumeBackupCode(adminId, parseHashes(admin.totpBackupHashes), code);
    if (!used) throw new UnauthorizedError("Invalid authenticator or backup code");
    return true;
  }

  async adminReset(targetId: string, actorId: string, actorEmail: string, actorRole: string) {
    if (actorRole !== "super_admin") {
      throw new ForbiddenError("Only a super admin can reset another staff member's authenticator");
    }
    const target = await prisma.adminUser.findUnique({ where: { id: targetId } });
    if (!target) throw new NotFoundError("Staff not found");
    await prisma.adminUser.update({
      where: { id: targetId },
      data: {
        totpSecret: null,
        totpPendingSecret: null,
        totpEnabled: false,
        totpBackupHashes: null,
        totpEnrolledAt: null,
        totpLastUsedAt: null,
      },
    });
    await audit(actorEmail, "auth.mfa.reset", `Reset by ${actorId}`, { adminId: targetId });
    return { enabled: false, id: targetId };
  }
}

export const adminMfaService = new AdminMfaService();
