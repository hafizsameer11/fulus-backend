export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, statusCode = 400, code = "APP_ERROR", details?: unknown) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, 401, "UNAUTHORIZED");
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(message, 404, "NOT_FOUND");
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict") {
    super(message, 409, "CONFLICT");
  }
}

const PROVIDER_NAMES = ["strowallet", "busha", "prembly", "pagocards", "esim-go", "esim go", "pago"];

/** Strip vendor brands from copy that may reach the app UI. */
export function toUserFacingErrorMessage(message: string, fallback = "Something went wrong. Please try again."): string {
  let msg = String(message ?? "").trim();
  if (!msg) return fallback;

  // "strowallet: …"
  msg = msg.replace(/^(strowallet|busha|prembly|pagocards|esim-go|esim go)\s*:\s*/i, "").trim();

  if (/^(strowallet\s+)?request failed$/i.test(msg)) {
    return "Payment could not be completed. Please try again.";
  }
  if (/api keys? are not configured/i.test(msg)) {
    return "This service is temporarily unavailable. Please try again later.";
  }
  if (/request failed with status\s*\d+/i.test(msg)) {
    return "Payment could not be completed. Please try again.";
  }
  if (/provider unavailable|live provider/i.test(msg)) {
    return "This service is temporarily unavailable. Please try again later.";
  }

  for (const name of PROVIDER_NAMES) {
    msg = msg.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "");
  }
  msg = msg.replace(/\s{2,}/g, " ").replace(/^[:\-–—]+\s*/, "").trim();

  return msg || fallback;
}

/**
 * Upstream integration failure. Message is always user-safe (no vendor names).
 * Provider id is kept in `details.provider` for logs / ops only.
 */
export class ProviderError extends AppError {
  readonly provider: string;

  constructor(provider: string, message: string, details?: unknown) {
    const safe = toUserFacingErrorMessage(message, "Payment could not be completed. Please try again.");
    super(safe, 502, "PROVIDER_ERROR", {
      provider,
      ...(details && typeof details === "object" ? { upstream: details } : details ? { upstream: details } : {}),
    });
    this.provider = provider;
  }
}
