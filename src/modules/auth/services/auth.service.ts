import bcrypt from "bcryptjs";
import { createHash, randomInt } from "node:crypto";
import { z } from "zod";
import { EmailOtpPurpose, WalletCurrency } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { AppError, ConflictError, UnauthorizedError } from "../../../lib/errors.js";
import { signAccessToken } from "../../../middleware/auth.js";
import { emailConfigured, otpEmailContent, sendEmail } from "../../../lib/mailer.js";
import { env } from "../../../config/env.js";

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().min(8).optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().min(1, "Email is required").email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

export const verifyOtpSchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/),
  purpose: z.enum(["SIGNUP", "RESET"]),
});

export const resendOtpSchema = z.object({
  email: z.string().email(),
  purpose: z.enum(["SIGNUP", "RESET"]),
});

export const resetPasswordSchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/),
  newPassword: z.string().min(8),
});

const DEFAULT_WALLETS: Array<{ currency: WalletCurrency; isVirtual: boolean }> = [
  { currency: WalletCurrency.NGN, isVirtual: false },
  { currency: WalletCurrency.USD, isVirtual: true },
  { currency: WalletCurrency.SAR, isVirtual: true },
];

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

function hashOtp(code: string) {
  return createHash("sha256").update(code).digest("hex");
}

function makeOtpCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function publicUser<T extends Record<string, unknown>>(user: T) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone,
    kycStatus: user.kycStatus,
    kycTier: user.kycTier,
    status: user.status,
    emailVerifiedAt: user.emailVerifiedAt ?? null,
    createdAt: user.createdAt,
  };
}

export class AuthService {
  private async issueOtp(email: string, purpose: EmailOtpPurpose) {
    const code = makeOtpCode();
    const codeHash = hashOtp(code);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    await prisma.emailOtp.updateMany({
      where: { email, purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    await prisma.emailOtp.create({
      data: { email, purpose, codeHash, expiresAt },
    });

    const content = otpEmailContent(code, purpose);
    const sent = await sendEmail({ to: email, ...content });

    const payload: {
      ok: true;
      email: string;
      purpose: EmailOtpPurpose;
      expiresInSec: number;
      simulated: boolean;
      devCode?: string;
    } = {
      ok: true,
      email,
      purpose,
      expiresInSec: Math.floor(OTP_TTL_MS / 1000),
      simulated: sent.simulated,
    };

    // Only expose code when mailer is not configured (local/dev).
    if (sent.simulated && env.NODE_ENV !== "production") {
      payload.devCode = code;
      console.info(`[otp:dev] ${purpose} ${email} => ${code}`);
    }

    return payload;
  }

  private async assertOtp(
    email: string,
    purpose: EmailOtpPurpose,
    code: string,
    options: { consume?: boolean } = {},
  ) {
    const consume = options.consume !== false;
    const row = await prisma.emailOtp.findFirst({
      where: { email, purpose, consumedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (!row) throw new AppError("No active code. Request a new one.", 400, "OTP_NOT_FOUND");
    if (row.expiresAt.getTime() < Date.now()) {
      throw new AppError("Code expired. Request a new one.", 400, "OTP_EXPIRED");
    }
    if (row.attempts >= OTP_MAX_ATTEMPTS) {
      throw new AppError("Too many attempts. Request a new code.", 429, "OTP_LOCKED");
    }

    const valid = row.codeHash === hashOtp(code);
    await prisma.emailOtp.update({
      where: { id: row.id },
      data: {
        attempts: { increment: 1 },
        ...(valid && consume ? { consumedAt: new Date() } : {}),
      },
    });
    if (!valid) throw new AppError("Invalid code", 400, "OTP_INVALID");
    return row;
  }

  async register(input: z.infer<typeof registerSchema>) {
    const email = input.email.toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email } });

    // Incomplete signup: resume verification instead of blocking.
    if (existing && !existing.emailVerifiedAt) {
      if (existing.status !== "ACTIVE") {
        throw new AppError("Account is not active", 403, "ACCOUNT_INACTIVE");
      }
      const passwordHash = await bcrypt.hash(input.password, 12);
      const user = await prisma.user.update({
        where: { id: existing.id },
        data: {
          passwordHash,
          ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
          ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          kycStatus: true,
          kycTier: true,
          status: true,
          emailVerifiedAt: true,
          createdAt: true,
        },
      });
      const otp = await this.issueOtp(email, EmailOtpPurpose.SIGNUP);
      const accessToken = signAccessToken({ id: user.id, email: user.email });
      return {
        user: publicUser(user),
        accessToken,
        requiresEmailVerification: true,
        resumed: true,
        otp,
      };
    }

    if (existing) throw new ConflictError("Email already registered");

    const passwordHash = await bcrypt.hash(input.password, 12);
    const user = await prisma.user.create({
      data: {
        email,
        phone: input.phone,
        firstName: input.firstName,
        lastName: input.lastName,
        passwordHash,
        emailVerifiedAt: null,
        wallets: {
          create: DEFAULT_WALLETS.map((w) => ({
            currency: w.currency,
            isVirtual: w.isVirtual,
          })),
        },
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        kycStatus: true,
        kycTier: true,
        status: true,
        emailVerifiedAt: true,
        createdAt: true,
      },
    });

    const otp = await this.issueOtp(email, EmailOtpPurpose.SIGNUP);
    const accessToken = signAccessToken({ id: user.id, email: user.email });
    return {
      user: publicUser(user),
      accessToken,
      requiresEmailVerification: true,
      otp,
    };
  }

  async login(input: z.infer<typeof loginSchema>) {
    const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
    if (!user) {
      throw new AppError("No account found with this email", 401, "EMAIL_NOT_FOUND");
    }

    const valid = await bcrypt.compare(input.password, user.passwordHash);
    if (!valid) {
      throw new AppError("Incorrect password", 401, "INVALID_PASSWORD");
    }
    if (user.status !== "ACTIVE") throw new AppError("Account is not active", 403, "ACCOUNT_INACTIVE");

    const accessToken = signAccessToken({ id: user.id, email: user.email });
    const requiresEmailVerification = !user.emailVerifiedAt;
    let otp: Awaited<ReturnType<AuthService["issueOtp"]>> | undefined;
    if (requiresEmailVerification) {
      otp = await this.issueOtp(user.email, EmailOtpPurpose.SIGNUP);
    }

    return {
      user: publicUser(user),
      accessToken,
      requiresEmailVerification,
      ...(otp ? { otp } : {}),
    };
  }

  async forgotPassword(input: z.infer<typeof forgotPasswordSchema>) {
    const email = input.email.toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });
    // Always look successful to avoid email enumeration.
    if (!user) {
      return {
        ok: true,
        email,
        purpose: "RESET" as const,
        expiresInSec: Math.floor(OTP_TTL_MS / 1000),
        simulated: !emailConfigured(),
        message: "If this email exists, a reset code was sent.",
      };
    }
    const otp = await this.issueOtp(email, EmailOtpPurpose.RESET);
    return { ...otp, message: "If this email exists, a reset code was sent." };
  }

  async resendOtp(input: z.infer<typeof resendOtpSchema>) {
    const email = input.email.toLowerCase();
    const purpose = input.purpose as EmailOtpPurpose;

    if (purpose === EmailOtpPurpose.SIGNUP) {
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) throw new AppError("Account not found", 404, "USER_NOT_FOUND");
      if (user.emailVerifiedAt) throw new AppError("Email already verified", 400, "ALREADY_VERIFIED");
    } else {
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        return {
          ok: true,
          email,
          purpose,
          expiresInSec: Math.floor(OTP_TTL_MS / 1000),
          simulated: !emailConfigured(),
          message: "If this email exists, a reset code was sent.",
        };
      }
    }

    return this.issueOtp(email, purpose);
  }

  async verifyOtp(input: z.infer<typeof verifyOtpSchema>) {
    const email = input.email.toLowerCase();
    const purpose = input.purpose as EmailOtpPurpose;

    if (purpose === EmailOtpPurpose.SIGNUP) {
      await this.assertOtp(email, purpose, input.code, { consume: true });
      const user = await prisma.user.update({
        where: { email },
        data: { emailVerifiedAt: new Date() },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          kycStatus: true,
          kycTier: true,
          status: true,
          emailVerifiedAt: true,
          createdAt: true,
        },
      });
      const accessToken = signAccessToken({ id: user.id, email: user.email });
      return {
        ok: true,
        purpose,
        user: publicUser(user),
        accessToken,
      };
    }

    // RESET: validate only — reset-password consumes the code.
    await this.assertOtp(email, purpose, input.code, { consume: false });
    return { ok: true, purpose, email };
  }

  async resetPassword(input: z.infer<typeof resetPasswordSchema>) {
    const email = input.email.toLowerCase();
    await this.assertOtp(email, EmailOtpPurpose.RESET, input.code, { consume: true });
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw new AppError("Account not found", 404, "USER_NOT_FOUND");
    const passwordHash = await bcrypt.hash(input.newPassword, 12);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    return { ok: true };
  }
}

export const authService = new AuthService();
