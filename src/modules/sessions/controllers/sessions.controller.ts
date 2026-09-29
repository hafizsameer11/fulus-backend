import type { Request, Response } from "express";
import { ok } from "../../../lib/http.js";
import { UnauthorizedError } from "../../../lib/errors.js";
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
    const keepCurrent = req.body?.keepCurrent !== false;
    return ok(
      res,
      await sessionsService.revokeAll(
        req.user.id,
        keepCurrent ? req.user.sessionId : undefined,
        true,
      ),
    );
  };

  revokeCurrent = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await sessionsService.revokeCurrentSession(req.user.id, req.user.sessionId));
  };
}

export const sessionsController = new SessionsController();
