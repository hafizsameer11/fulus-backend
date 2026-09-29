import type { Request, Response } from "express";
import path from "node:path";
import { ok } from "../../../lib/http.js";
import { UnauthorizedError } from "../../../lib/errors.js";
import {
  changePasswordSchema,
  closureRequestSchema,
  updateProfileSchema,
  usersService,
} from "../services/users.service.js";

export class UsersController {
  me = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await usersService.getMe(req.user.id));
  };

  updateMe = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await usersService.updateMe(req.user.id, updateProfileSchema.parse(req.body)));
  };

  avatar = async (req: Request, res: Response) => {
    const userId = String(req.params.userId ?? "");
    const { abs, avatarPath } = await usersService.getAvatarFile(userId);
    const ext = path.extname(avatarPath).toLowerCase();
    const mime =
      ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Content-Type", mime);
    return res.sendFile(abs);
  };

  changePassword = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await usersService.changePassword(req.user.id, changePasswordSchema.parse(req.body)));
  };

  inbox = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await usersService.listInbox(req.user.id));
  };

  markInboxRead = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await usersService.markInboxRead(req.user.id, String(req.params.id)));
  };

  closureRequest = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await usersService.requestClosure(req.user.id, closureRequestSchema.parse(req.body)));
  };
}

export const usersController = new UsersController();
