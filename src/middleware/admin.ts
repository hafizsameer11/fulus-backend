import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { UnauthorizedError } from "../lib/errors.js";

export type AdminStaff = {
  id: string;
  email: string;
  name: string;
  role: string;
  kind: "staff";
};

declare global {
  namespace Express {
    interface Request {
      admin?: AdminStaff;
    }
  }
}

export function signAdminToken(staff: Omit<AdminStaff, "kind">) {
  const payload: AdminStaff = { ...staff, kind: "staff" };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: "8h" });
}

/** Accept staff JWT from login. Optional ADMIN_API_KEY only for scripts. */
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const bearer = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const headerKey = req.header("x-admin-key");

  if (bearer) {
    try {
      const payload = jwt.verify(bearer, env.JWT_SECRET) as Partial<AdminStaff>;
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
