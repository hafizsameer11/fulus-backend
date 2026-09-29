import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { UnauthorizedError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { sessionsService } from "../modules/sessions/services/sessions.service.js";

export type AuthUser = {
  id: string;
  email: string;
  sessionId?: string;
  tokenVersion?: number;
};

type JwtPayload = AuthUser & { sid?: string; tv?: number };

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signAccessToken(user: AuthUser) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      ...(user.sessionId ? { sid: user.sessionId } : {}),
      ...(user.tokenVersion !== undefined ? { tv: user.tokenVersion } : {}),
    },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"] },
  );
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return next(new UnauthorizedError("Missing bearer token"));
  }

  void (async () => {
    try {
      const token = header.slice("Bearer ".length);
      const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
      const sessionId = payload.sid ?? payload.sessionId;
      const tokenVersion = payload.tv ?? payload.tokenVersion ?? 0;

      const user = await prisma.user.findUnique({
        where: { id: payload.id },
        select: { id: true, email: true, tokenVersion: true, status: true },
      });
      if (!user || user.status !== "ACTIVE") {
        return next(new UnauthorizedError("Invalid or expired token"));
      }
      if (tokenVersion < user.tokenVersion) {
        return next(new UnauthorizedError("Session revoked"));
      }

      req.user = {
        id: user.id,
        email: user.email,
        sessionId,
        tokenVersion: user.tokenVersion,
      };
      void sessionsService.touchSession(sessionId);
      return next();
    } catch {
      return next(new UnauthorizedError("Invalid or expired token"));
    }
  })();
}
