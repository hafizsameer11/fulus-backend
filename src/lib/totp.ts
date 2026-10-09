import crypto from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Generate a random base32 secret (default 20 bytes → 32 chars). */
export function generateTotpSecret(bytes = 20): string {
  const buf = crypto.randomBytes(bytes);
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) throw new Error("Invalid base32 secret");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(secret: Buffer, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(code % 10 ** digits).padStart(digits, "0");
}

export function totpAt(secretBase32: string, atMs = Date.now(), stepSec = 30): string {
  const counter = Math.floor(atMs / 1000 / stepSec);
  return hotp(base32Decode(secretBase32), counter);
}

/** Accept current window ± skew steps (default ±1 → 90s). */
export function verifyTotp(secretBase32: string, code: string, skew = 1, stepSec = 30): boolean {
  const digits = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(digits)) return false;
  const now = Date.now();
  for (let w = -skew; w <= skew; w++) {
    if (totpAt(secretBase32, now + w * stepSec * 1000, stepSec) === digits) return true;
  }
  return false;
}

export function otpauthUri(opts: { email: string; secret: string; issuer?: string }) {
  const issuer = opts.issuer || "Fulus Admin";
  const label = encodeURIComponent(`${issuer}:${opts.email}`);
  const q = new URLSearchParams({
    secret: opts.secret.replace(/\s/g, ""),
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}

/** Format base32 secret in groups of 4 for display. */
export function formatSecret(secret: string) {
  return secret.replace(/\s/g, "").replace(/(.{4})/g, "$1 ").trim();
}

export function generateBackupCodes(count = 8): string[] {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = crypto.randomBytes(8);
    let s = "";
    for (const b of bytes) s += alphabet[b % alphabet.length];
    codes.push(`${s.slice(0, 4)}-${s.slice(4, 8)}`);
  }
  return codes;
}
