import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { UnauthorizedError } from "../../../lib/errors.js";
import { ok } from "../../../lib/http.js";
import { signAdminMfaPendingToken, signAdminToken } from "../../../middleware/admin.js";
import { prisma } from "../../../lib/prisma.js";
import { kycService } from "../../kyc/services/kyc.service.js";
import { killSwitchService, putKillSwitchesSchema } from "../services/kill-switch.service.js";
import { adminMfaService } from "../services/admin-mfa.service.js";
import { adminReplySchema, supportService } from "../../support/services/support.service.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const codeSchema = z.object({
  code: z.string().min(6).max(64),
});

export class AdminAuthController {
  /** Email/password against AdminUser. MFA challenge only when authenticator is enrolled. */
  login = async (req: Request, res: Response) => {
    const input = loginSchema.parse(req.body ?? {});
    const email = input.email.trim().toLowerCase();
    const admin = await prisma.adminUser.findUnique({ where: { email } });
    if (!admin || !admin.active) {
      throw new UnauthorizedError("Invalid email or password");
    }
    const valid = await bcrypt.compare(input.password, admin.passwordHash);
    if (!valid) {
      throw new UnauthorizedError("Invalid email or password");
    }

    const staff = {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
    };

    if (admin.totpEnabled && admin.totpSecret) {
      const token = signAdminMfaPendingToken(staff);
      return ok(res, { token, staff, expiresIn: "10m", requiresMfa: true, mfaEnabled: true });
    }

    const token = signAdminToken(staff);
    return ok(res, { token, staff, expiresIn: "8h", requiresMfa: false, mfaEnabled: false });
  };

  /** Complete MFA challenge with TOTP or a one-time backup code. */
  mfa = async (req: Request, res: Response) => {
    const pending = req.adminMfaPending;
    if (!pending) throw new UnauthorizedError("Sign in required");
    const body = codeSchema.parse(req.body ?? {});
    await adminMfaService.verifyLogin(pending.id, body.code);
    const staff = {
      id: pending.id,
      email: pending.email,
      name: pending.name,
      role: pending.role,
    };
    const token = signAdminToken(staff);
    return ok(res, { ok: true, token, staff, expiresIn: "8h" });
  };

  me = async (req: Request, res: Response) => {
    if (!req.admin) throw new UnauthorizedError();
    // Refresh role/active from DB so offboard / role changes apply without waiting for JWT expiry
    const row =
      req.admin.id === "api-key"
        ? null
        : await prisma.adminUser.findUnique({
            where: { id: req.admin.id },
            select: { id: true, email: true, name: true, role: true, active: true },
          });
    if (row && !row.active) throw new UnauthorizedError("Account deactivated");
    const staff = row
      ? { id: row.id, email: row.email, name: row.name, role: row.role, kind: "staff" as const }
      : req.admin;
    const mfa = await adminMfaService.status(staff.id).catch(() => null);
    return ok(res, {
      staff,
      mfa: mfa
        ? { enabled: mfa.enabled, enrolledAt: mfa.enrolledAt, lastUsedAt: mfa.lastUsedAt }
        : { enabled: false, enrolledAt: null, lastUsedAt: null },
    });
  };

  mfaStatus = async (req: Request, res: Response) => {
    if (!req.admin) throw new UnauthorizedError();
    return ok(res, await adminMfaService.status(req.admin.id));
  };

  mfaSetup = async (req: Request, res: Response) => {
    if (!req.admin) throw new UnauthorizedError();
    return ok(res, await adminMfaService.beginSetup(req.admin.id, req.admin.email));
  };

  mfaConfirm = async (req: Request, res: Response) => {
    if (!req.admin) throw new UnauthorizedError();
    const body = codeSchema.parse(req.body ?? {});
    return ok(res, await adminMfaService.confirmSetup(req.admin.id, body.code, req.admin.email));
  };

  mfaDisable = async (req: Request, res: Response) => {
    if (!req.admin) throw new UnauthorizedError();
    const body = codeSchema.parse(req.body ?? {});
    return ok(res, await adminMfaService.disable(req.admin.id, body.code, req.admin.email));
  };

  mfaRegenBackup = async (req: Request, res: Response) => {
    if (!req.admin) throw new UnauthorizedError();
    const body = codeSchema.parse(req.body ?? {});
    return ok(res, await adminMfaService.regenerateBackupCodes(req.admin.id, body.code, req.admin.email));
  };

  mfaAdminReset = async (req: Request, res: Response) => {
    if (!req.admin) throw new UnauthorizedError();
    const id = String(req.params.id ?? "");
    return ok(
      res,
      await adminMfaService.adminReset(id, req.admin.id, req.admin.email, req.admin.role),
    );
  };
}

export class AdminKycController {
  list = async (req: Request, res: Response) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const where = status ? { status: status as "PENDING" | "PASSED" | "FAILED" } : {};
    const checks = await prisma.kycCheck.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            phone: true,
            kycTier: true,
            kycStatus: true,
          },
        },
      },
    });
    return ok(res, { checks });
  };

  approve = async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    return ok(res, await kycService.adminApproveCheck(id, req.admin?.email ?? "admin"));
  };

  reject = async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const body = z.object({ reason: z.string().min(3).max(500).default("Rejected by compliance") }).parse(req.body ?? {});
    return ok(res, await kycService.adminRejectCheck(id, body.reason, req.admin?.email ?? "admin"));
  };

  evidence = async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    return ok(res, await kycService.adminGetEvidence(id));
  };
}

export class AdminSupportController {
  list = async (req: Request, res: Response) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const userId = typeof req.query.userId === "string" ? req.query.userId : undefined;
    return ok(res, { tickets: await supportService.adminListTickets(status, userId) });
  };

  get = async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    return ok(res, await supportService.adminGetTicket(id));
  };

  reply = async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const body = adminReplySchema.parse(req.body ?? {});
    return ok(
      res,
      await supportService.adminReply(id, body, req.admin?.email ?? "admin"),
    );
  };
}

export class AdminKillSwitchController {
  list = async (_req: Request, res: Response) => ok(res, await killSwitchService.list());

  put = async (req: Request, res: Response) =>
    ok(res, await killSwitchService.upsert(putKillSwitchesSchema.parse(req.body ?? {})));
}

export const adminAuthController = new AdminAuthController();
export const adminKycController = new AdminKycController();
export const adminKillSwitchController = new AdminKillSwitchController();
export const adminSupportController = new AdminSupportController();
