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

const DEV_KEY = "fulus-admin-dev-key";

export function signAdminToken(staff: Omit<AdminStaff, "kind">) {
  const payload: AdminStaff = { ...staff, kind: "staff" };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: "8h" });
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const headerKey = req.header("x-admin-key");
  const bearer = req.header("authorization")?.replace(/^Bearer\s+/i, "");

  if (headerKey) {
    if (env.NODE_ENV === "production" && headerKey === DEV_KEY) {
      return next(new UnauthorizedError("Default admin key is disabled"));
    }
    if (headerKey === env.ADMIN_API_KEY) {
      req.admin = {
        id: "api-key",
        email: "api-key@fulus.local",
        name: "API Key",
        role: "super_admin",
        kind: "staff",
      };
      return next();
    }
  }

  if (bearer) {
    try {
      const payload = jwt.verify(bearer, env.JWT_SECRET) as Partial<AdminStaff>;
      if (payload.kind === "staff" && payload.email && payload.id) {
        req.admin = {
          id: payload.id,
          email: payload.email,
          name: payload.name ?? payload.email,
          role: payload.role ?? "ops",
          kind: "staff",
        };
        return next();
      }
    } catch {
      /* fall through */
    }
    // Legacy: some clients still send the shared key as Bearer
    if (bearer === env.ADMIN_API_KEY) {
      if (env.NODE_ENV === "production" && bearer === DEV_KEY) {
        return next(new UnauthorizedError("Default admin key is disabled"));
      }
      req.admin = {
        id: "api-key",
        email: "api-key@fulus.local",
        name: "API Key",
        role: "super_admin",
        kind: "staff",
      };
      return next();
    }
  }

  return next(new UnauthorizedError("Invalid admin credentials"));
}
