import { createHash, randomBytes } from "node:crypto";
import type { Request } from "express";
import { prisma } from "../../../lib/prisma.js";
import { AppError, NotFoundError } from "../../../lib/errors.js";
import { deviceLabelFromUserAgent } from "../../../lib/user-agent.js";
import { env } from "../../../config/env.js";

const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hashToken(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
}

function refreshExpiresAt() {
  return new Date(Date.now() + REFRESH_TTL_MS);
}

export type SessionIssue = {
  sessionId: string;
  refreshToken: string;
};

export class SessionsService {
  userAgentFromRequest(req: Request) {
    const ua = req.headers["user-agent"];
    return typeof ua === "string" ? ua : undefined;
  }

  async createSession(userId: string, req: Request): Promise<SessionIssue> {
    const userAgent = this.userAgentFromRequest(req);
    const deviceLabel = deviceLabelFromUserAgent(userAgent);
    const raw = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(raw);

    const row = await prisma.refreshToken.create({
      data: {
        userId,
        tokenHash,
        deviceLabel,
        userAgent,
        expiresAt: refreshExpiresAt(),
      },
    });

    return { sessionId: row.id, refreshToken: raw };
  }

  async touchSession(sessionId: string | undefined) {
    if (!sessionId) return;
    await prisma.refreshToken.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { lastSeenAt: new Date() },
    });
  }

  async listSessions(userId: string, currentSessionId?: string) {
    const rows = await prisma.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: "desc" },
    });

    return rows.map((r) => ({
      id: r.id,
      deviceLabel: r.deviceLabel ?? "Unknown device",
      userAgent: r.userAgent,
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt,
      expiresAt: r.expiresAt,
      current: r.id === currentSessionId,
    }));
  }

  async revokeSession(userId: string, sessionId: string, currentSessionId?: string) {
    const row = await prisma.refreshToken.findFirst({
      where: { id: sessionId, userId, revokedAt: null },
    });
    if (!row) throw new NotFoundError("Session not found");
    if (sessionId === currentSessionId) {
      throw new AppError("Use sign out to end the current session", 400, "CURRENT_SESSION");
    }
    await prisma.refreshToken.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  }

  async revokeAll(userId: string, currentSessionId?: string, bumpTokenVersion = true) {
    await prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null, ...(currentSessionId ? { id: { not: currentSessionId } } : {}) },
      data: { revokedAt: new Date() },
    });

    if (bumpTokenVersion) {
      await prisma.user.update({
        where: { id: userId },
        data: { tokenVersion: { increment: 1 } },
      });
    }

    return { ok: true };
  }

  async revokeCurrentSession(userId: string, sessionId: string | undefined) {
    if (sessionId) {
      await prisma.refreshToken.updateMany({
        where: { id: sessionId, userId },
        data: { revokedAt: new Date() },
      });
    }
    return { ok: true };
  }

  refreshCookieName() {
    return env.NODE_ENV === "production" ? "__Host-fulus_rt" : "fulus_rt";
  }
}

export const sessionsService = new SessionsService();
