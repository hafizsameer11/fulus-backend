import type { Request, Response } from "express";
import { ok } from "../../../lib/http.js";
import { UnauthorizedError } from "../../../lib/errors.js";
import { changePasswordSchema, updateProfileSchema, usersService } from "../services/users.service.js";

export class UsersController {
  me = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await usersService.getMe(req.user.id));
  };

  updateMe = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await usersService.updateMe(req.user.id, updateProfileSchema.parse(req.body)));
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
}

export const usersController = new UsersController();
