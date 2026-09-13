import type { NextFunction, Request, Response } from "express";
import { ZodError, type ZodType } from "zod";
import { AppError, toUserFacingErrorMessage } from "../lib/errors.js";
import { fail } from "../lib/http.js";

function zodUserMessage(err: ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "Validation failed";

  const path = issue.path.map(String).join(".");
  const fieldLabels: Record<string, string> = {
    email: "Email",
    password: "Password",
    newPassword: "New password",
    currentPassword: "Current password",
    code: "Code",
    phone: "Phone",
    firstName: "First name",
    lastName: "Last name",
  };

  // Prefer schema custom messages when present
  const msg = issue.message?.trim() || "Invalid value";
  if (!path) return msg;

  // Avoid duplicating "Email: Enter a valid email…" style when message already names the field
  const label = fieldLabels[path] ?? path;
  if (msg.toLowerCase().includes(label.toLowerCase())) return msg;
  return `${label}: ${msg}`;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return fail(
      res,
      toUserFacingErrorMessage(err.message, err.message),
      err.statusCode,
      err.code,
      // Never leak raw upstream payloads to clients
      err.code === "PROVIDER_ERROR" ? undefined : err.details,
    );
  }

  if (err instanceof ZodError) {
    return fail(res, zodUserMessage(err), 422, "VALIDATION_ERROR", err.flatten());
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
