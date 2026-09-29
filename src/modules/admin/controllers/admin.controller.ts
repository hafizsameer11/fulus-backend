import type { Request, Response } from "express";
import { z } from "zod";
import { env } from "../../../config/env.js";
import { AppError, UnauthorizedError } from "../../../lib/errors.js";
import { ok } from "../../../lib/http.js";
import { signAdminToken } from "../../../middleware/admin.js";
import { prisma } from "../../../lib/prisma.js";
import { kycService } from "../../kyc/services/kyc.service.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export class AdminAuthController {
  /** Email/password staff login — no authenticator / Google 2FA. */
  login = async (req: Request, res: Response) => {
    const input = loginSchema.parse(req.body ?? {});
    const expectedEmail = env.ADMIN_STAFF_EMAIL.trim().toLowerCase();
    const expectedPassword = env.ADMIN_STAFF_PASSWORD;

    if (!expectedEmail || !expectedPassword) {
      throw new AppError(
        "Staff login is not configured. Set ADMIN_STAFF_EMAIL and ADMIN_STAFF_PASSWORD.",
        503,
        "STAFF_AUTH_UNCONFIGURED",
      );
    }

    if (input.email.trim().toLowerCase() !== expectedEmail || input.password !== expectedPassword) {
      throw new UnauthorizedError("Invalid staff email or password");
    }

    const staff = {
      id: `staff:${expectedEmail}`,
      email: expectedEmail,
      name: env.ADMIN_STAFF_NAME || "Fulus Admin",
      role: "super_admin",
    };
    const token = signAdminToken(staff);
    return ok(res, { token, staff, expiresIn: "8h" });
  };

  me = async (req: Request, res: Response) => {
    if (!req.admin) throw new UnauthorizedError();
    return ok(res, { staff: req.admin });
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
}

export const adminAuthController = new AdminAuthController();
export const adminKycController = new AdminKycController();
