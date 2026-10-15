import type { Request, Response } from "express";
import { ok } from "../../../lib/http.js";
import { AppError, UnauthorizedError } from "../../../lib/errors.js";
import { sessionsService } from "../services/sessions.service.js";

export class SessionsController {
  list = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, {
      sessions: await sessionsService.listSessions(req.user.id, req.user.sessionId),
    });
  };

  revoke = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    const id = String(req.params.id ?? "");
    return ok(res, await sessionsService.revokeSession(req.user.id, id, req.user.sessionId));
  };

  revokeAll = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    // Default: keep this device signed in (sign out others only).
    const keepCurrent = req.body?.keepCurrent !== false;
    if (keepCurrent && !req.user.sessionId) {
      // Old tokens without `sid` can't safely spare "current" — ask for a fresh login.
      throw new AppError(
        "Please sign out and sign in again to manage other devices.",
        400,
        "SESSION_REQUIRED",
      );
    }
    return ok(
      res,
      await sessionsService.revokeAll(
        req.user.id,
        keepCurrent ? req.user.sessionId : undefined,
        // Bumping tokenVersion invalidates THIS device's JWT too — only do it for full sign-out.
        !keepCurrent,
      ),
    );
  };

  revokeCurrent = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await sessionsService.revokeCurrentSession(req.user.id, req.user.sessionId));
  };
}

export const sessionsController = new SessionsController();
