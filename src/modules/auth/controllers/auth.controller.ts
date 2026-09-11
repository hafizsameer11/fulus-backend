import type { Request, Response } from "express";
import { created, ok } from "../../../lib/http.js";
import {
  authService,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resendOtpSchema,
  resetPasswordSchema,
  verifyOtpSchema,
} from "../services/auth.service.js";

export class AuthController {
  register = async (req: Request, res: Response) => {
    const input = registerSchema.parse(req.body);
    const result = await authService.register(input);
    return created(res, result);
  };

  login = async (req: Request, res: Response) => {
    const input = loginSchema.parse(req.body);
    const result = await authService.login(input);
    return ok(res, result);
  };

  forgotPassword = async (req: Request, res: Response) => {
    return ok(res, await authService.forgotPassword(forgotPasswordSchema.parse(req.body)));
  };

  verifyOtp = async (req: Request, res: Response) => {
    return ok(res, await authService.verifyOtp(verifyOtpSchema.parse(req.body)));
  };

  resendOtp = async (req: Request, res: Response) => {
    return ok(res, await authService.resendOtp(resendOtpSchema.parse(req.body)));
  };

  resetPassword = async (req: Request, res: Response) => {
    return ok(res, await authService.resetPassword(resetPasswordSchema.parse(req.body)));
  };
}

export const authController = new AuthController();
