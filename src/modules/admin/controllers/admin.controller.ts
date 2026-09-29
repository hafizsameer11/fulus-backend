import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { UnauthorizedError } from "../../../lib/errors.js";
import { ok } from "../../../lib/http.js";
import { signAdminToken } from "../../../middleware/admin.js";
import { prisma } from "../../../lib/prisma.js";
import { kycService } from "../../kyc/services/kyc.service.js";
import { killSwitchService, putKillSwitchesSchema } from "../services/kill-switch.service.js";
import { adminReplySchema, supportService } from "../../support/services/support.service.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export class AdminAuthController {
  /** Simple email/password against seeded AdminUser. */
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

  evidence = async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    return ok(res, await kycService.adminGetEvidence(id));
  };
}

export class AdminSupportController {
  list = async (req: Request, res: Response) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    return ok(res, { tickets: await supportService.adminListTickets(status) });
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
