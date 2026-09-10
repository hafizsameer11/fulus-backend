import type { Response } from "express";

export function ok<T>(res: Response, data: T, status = 200) {
  return res.status(status).json({ success: true, data });
}

export function created<T>(res: Response, data: T) {
  return ok(res, data, 201);
}

export function fail(res: Response, message: string, status = 400, code = "BAD_REQUEST", details?: unknown) {
  return res.status(status).json({ success: false, error: { code, message, details } });
}

export function makeReference(prefix: string) {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}_${stamp}${rand}`;
}
