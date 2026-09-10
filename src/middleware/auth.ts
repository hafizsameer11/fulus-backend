import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { UnauthorizedError } from "../lib/errors.js";

export type AuthUser = {
  id: string;
  email: string;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signAccessToken(user: AuthUser) {
  return jwt.sign(user, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"] });
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return next(new UnauthorizedError("Missing bearer token"));
  }

  try {
    const token = header.slice("Bearer ".length);
    const payload = jwt.verify(token, env.JWT_SECRET) as AuthUser;
    req.user = { id: payload.id, email: payload.email };
    return next();
  } catch {
    return next(new UnauthorizedError("Invalid or expired token"));
  }
}
