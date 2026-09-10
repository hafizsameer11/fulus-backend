import type { NextFunction, Request, Response } from "express";
import { ZodError, type ZodType } from "zod";
import { AppError } from "../lib/errors.js";
import { fail } from "../lib/http.js";

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return fail(res, err.message, err.statusCode, err.code, err.details);
  }

  if (err instanceof ZodError) {
    return fail(res, "Validation failed", 422, "VALIDATION_ERROR", err.flatten());
  }

  console.error(err);
  return fail(res, "Internal server error", 500, "INTERNAL_ERROR");
}

export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.body = schema.parse(req.body);
    next();
  };
}

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
