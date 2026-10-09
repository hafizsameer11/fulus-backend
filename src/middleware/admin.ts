import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { ForbiddenError, UnauthorizedError } from "../lib/errors.js";
import {
  canAccessModule,
  canManageStaff,
  moduleForAdminPath,
} from "../modules/admin/lib/roles.js";

export type AdminStaff = {
  id: string;
  email: string;
  name: string;
  role: string;
  kind: "staff";
};

export type AdminMfaPending = {
  id: string;
  email: string;
  name: string;
  role: string;
  kind: "staff_mfa_pending";
};

declare global {
  namespace Express {
    interface Request {
      admin?: AdminStaff;
      adminMfaPending?: AdminMfaPending;
    }
  }
}

export function signAdminToken(staff: Omit<AdminStaff, "kind">) {
  const payload: AdminStaff = { ...staff, kind: "staff" };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: "8h" });
}

/** Short-lived token after password check when MFA is required. Cannot call admin APIs. */
export function signAdminMfaPendingToken(staff: Omit<AdminStaff, "kind">) {
  const payload: AdminMfaPending = { ...staff, kind: "staff_mfa_pending" };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: "10m" });
}

function readBearer(req: Request) {
  return req.header("authorization")?.replace(/^Bearer\s+/i, "") || undefined;
}

/** Accept full staff JWT. Optional ADMIN_API_KEY only for scripts. */
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const bearer = readBearer(req);
  const headerKey = req.header("x-admin-key");

  if (bearer) {
    try {
      const payload = jwt.verify(bearer, env.JWT_SECRET) as {
        id?: string;
        email?: string;
        name?: string;
        role?: string;
        kind?: string;
      };
      if (payload.kind === "staff" && payload.email && payload.id) {
        req.admin = {
          id: payload.id,
          email: payload.email,
          name: payload.name ?? payload.email,
          role: payload.role ?? "super_admin",
          kind: "staff",
        };
        return next();
      }
    } catch {
      /* fall through */
    }
  }

  const key = headerKey || bearer;
  if (key && env.ADMIN_API_KEY && key === env.ADMIN_API_KEY) {
    req.admin = {
      id: "api-key",
      email: "scripts@fulus.local",
      name: "API Key",
      role: "super_admin",
      kind: "staff",
    };
    return next();
  }

  return next(new UnauthorizedError("Sign in required"));
}

/**
 * After requireAdmin — enforce module RBAC from ROLE_MODULES.
 * `/admin/auth/*` always allowed for any signed-in staff.
 */
export function requireAdminModule(req: Request, _res: Response, next: NextFunction) {
  if (!req.admin) return next(new UnauthorizedError("Sign in required"));
  const full = `${req.baseUrl || ""}${req.path || ""}` || req.originalUrl || "";
  if (full.includes("/admin/auth")) return next();
  const adminPath = full.includes("/admin")
    ? full.slice(full.indexOf("/admin"))
    : `/admin${req.path || ""}`;
  const pathOnly = adminPath.split("?")[0] ?? adminPath;
  // Shared key-value store used by Config studio and Platform desks
  if (pathOnly.includes("/admin/platform-config")) {
    if (
      canAccessModule(req.admin.role, "/admin/platform") ||
      canAccessModule(req.admin.role, "/admin/config")
    ) {
      return next();
    }
    return next(new ForbiddenError("Your role cannot access platform configuration"));
  }
  const modulePath = moduleForAdminPath(pathOnly);
  if (modulePath === "/admin") return next();
  if (!canAccessModule(req.admin.role, modulePath)) {
    const label = modulePath.replace(/^\/admin\/?/, "") || "overview";
    return next(new ForbiddenError(`Your role cannot access the ${label} module`));
  }
  return next();
}

/** Staff invite / role / offboard — super_admin only. */
export function requireStaffManager(req: Request, _res: Response, next: NextFunction) {
  if (!req.admin) return next(new UnauthorizedError("Sign in required"));
  if (!canManageStaff(req.admin.role)) {
    return next(new ForbiddenError("Only Security / Platform Admin can manage staff"));
  }
  return next();
}

/** Accept only a pending MFA challenge JWT from password login. */
export function requireAdminMfaPending(req: Request, _res: Response, next: NextFunction) {
  const bearer = readBearer(req);
  if (!bearer) return next(new UnauthorizedError("Sign in required"));
  try {
    const payload = jwt.verify(bearer, env.JWT_SECRET) as Partial<AdminMfaPending>;
    if (payload.kind === "staff_mfa_pending" && payload.email && payload.id) {
      req.adminMfaPending = {
        id: payload.id,
        email: payload.email,
        name: payload.name ?? payload.email,
        role: payload.role ?? "super_admin",
        kind: "staff_mfa_pending",
      };
      return next();
    }
  } catch {
    /* fall through */
  }
  return next(new UnauthorizedError("Authenticator challenge expired — sign in again"));
}
