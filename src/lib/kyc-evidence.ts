import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "./errors.js";

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const KYC_STORAGE_ROOT = path.join(API_ROOT, "storage", "kyc");

export type KycEvidenceKind = "selfie" | "document";

function parseBase64Payload(raw: string): { ext: string; bytes: Buffer } {
  let payload = raw.trim();
  let ext = "jpg";
  const dataUrl = /^data:([^;]+);base64,(.+)$/i.exec(payload);
  if (dataUrl) {
    const mime = dataUrl[1]!.toLowerCase();
    payload = dataUrl[2]!;
    if (mime.includes("png")) ext = "png";
    else if (mime.includes("webp")) ext = "webp";
    else if (mime.includes("jpeg") || mime.includes("jpg")) ext = "jpg";
  }
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length < 32) throw new AppError("Invalid image payload", 400, "INVALID_IMAGE");
  return { ext, bytes };
}

/** Relative path under storage/kyc (safe to store in DB JSON). */
export async function saveKycEvidence(
  checkId: string,
  kind: KycEvidenceKind,
  base64OrDataUrl: string,
): Promise<string> {
  const { ext, bytes } = parseBase64Payload(base64OrDataUrl);
  const dir = path.join(KYC_STORAGE_ROOT, checkId);
  await fs.mkdir(dir, { recursive: true });
  const fileName = `${kind}.${ext}`;
  const abs = path.join(dir, fileName);
  await fs.writeFile(abs, bytes);
  return path.posix.join("kyc", checkId, fileName);
}

export function resolveKycEvidencePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.includes("..") || !normalized.startsWith("kyc/")) {
    throw new AppError("Invalid evidence path", 400, "INVALID_PATH");
  }
  return path.join(KYC_STORAGE_ROOT, normalized.slice("kyc/".length));
}

export async function readKycEvidenceBase64(relativePath: string): Promise<{ mime: string; base64: string }> {
  const abs = resolveKycEvidencePath(relativePath);
  const bytes = await fs.readFile(abs);
  const ext = path.extname(abs).toLowerCase();
  const mime =
    ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return { mime, base64: bytes.toString("base64") };
}
