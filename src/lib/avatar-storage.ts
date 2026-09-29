import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "./errors.js";

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const AVATAR_STORAGE_ROOT = path.join(API_ROOT, "storage", "avatars");

function parseBase64Payload(raw: string): { ext: string; bytes: Buffer; mime: string } {
  let payload = raw.trim();
  let ext = "jpg";
  let mime = "image/jpeg";
  const dataUrl = /^data:([^;]+);base64,(.+)$/i.exec(payload);
  if (dataUrl) {
    mime = dataUrl[1]!.toLowerCase();
    payload = dataUrl[2]!;
    if (mime.includes("png")) ext = "png";
    else if (mime.includes("webp")) ext = "webp";
    else if (mime.includes("jpeg") || mime.includes("jpg")) ext = "jpg";
  }
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length < 32) throw new AppError("Invalid image payload", 400, "INVALID_IMAGE");
  if (bytes.length > 3_500_000) throw new AppError("Image too large (max ~2.5MB)", 400, "IMAGE_TOO_LARGE");
  return { ext, bytes, mime };
}

/** Saves avatar and returns relative path `avatars/{userId}.{ext}`. */
export async function saveUserAvatar(userId: string, base64OrDataUrl: string): Promise<string> {
  const { ext, bytes } = parseBase64Payload(base64OrDataUrl);
  await fs.mkdir(AVATAR_STORAGE_ROOT, { recursive: true });
  // Remove prior extensions for this user
  for (const oldExt of ["jpg", "jpeg", "png", "webp"]) {
    await fs.unlink(path.join(AVATAR_STORAGE_ROOT, `${userId}.${oldExt}`)).catch(() => undefined);
  }
  const fileName = `${userId}.${ext}`;
  await fs.writeFile(path.join(AVATAR_STORAGE_ROOT, fileName), bytes);
  return path.posix.join("avatars", fileName);
}

export function resolveAvatarAbsPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.includes("..") || !normalized.startsWith("avatars/")) {
    throw new AppError("Invalid avatar path", 400, "INVALID_PATH");
  }
  return path.join(AVATAR_STORAGE_ROOT, normalized.slice("avatars/".length));
}
