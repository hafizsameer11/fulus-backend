import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { UnauthorizedError } from "../lib/errors.js";

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const key = req.header("x-admin-key") ?? req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!key || key !== env.ADMIN_API_KEY) {
    return next(new UnauthorizedError("Invalid admin key"));
  }
  return next();
}
