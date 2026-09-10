import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../../../lib/prisma.js";
import { AppError, ConflictError, UnauthorizedError } from "../../../lib/errors.js";
import { signAccessToken } from "../../../middleware/auth.js";
import { WalletCurrency } from "@prisma/client";
import { simulateProviders } from "../../../lib/simulate.js";
import { walletService } from "../../wallet/services/wallet.service.js";

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().min(8).optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const DEFAULT_WALLETS: Array<{ currency: WalletCurrency; isVirtual: boolean }> = [
  { currency: WalletCurrency.NGN, isVirtual: false },
  { currency: WalletCurrency.USD, isVirtual: true },
  { currency: WalletCurrency.SAR, isVirtual: true },
];

export class AuthService {
  async register(input: z.infer<typeof registerSchema>) {
    const existing = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
    if (existing) throw new ConflictError("Email already registered");

    const passwordHash = await bcrypt.hash(input.password, 12);
    const user = await prisma.user.create({
      data: {
        email: input.email.toLowerCase(),
        phone: input.phone,
        firstName: input.firstName,
        lastName: input.lastName,
        passwordHash,
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
        createdAt: true,
      },
    });

    // Seed demo balances so simulated flows work without a real deposit first.
    if (simulateProviders()) {
      await walletService.credit({
        userId: user.id,
        currency: "NGN",
        amount: 500_000,
        type: "ADJUSTMENT",
        description: "Simulated welcome credit",
        provider: "simulated",
      });
      await walletService.credit({
        userId: user.id,
        currency: "USD",
        amount: 250,
        type: "ADJUSTMENT",
        description: "Simulated welcome credit",
        provider: "simulated",
      });
      await walletService.credit({
        userId: user.id,
        currency: "SAR",
        amount: 1_000,
        type: "ADJUSTMENT",
        description: "Simulated welcome credit",
        provider: "simulated",
      });
    }

    const accessToken = signAccessToken({ id: user.id, email: user.email });
    return { user, accessToken };
  }

  async login(input: z.infer<typeof loginSchema>) {
    const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
    if (!user) throw new UnauthorizedError("Invalid email or password");

    const valid = await bcrypt.compare(input.password, user.passwordHash);
    if (!valid) throw new UnauthorizedError("Invalid email or password");
    if (user.status !== "ACTIVE") throw new AppError("Account is not active", 403, "ACCOUNT_INACTIVE");

    const accessToken = signAccessToken({ id: user.id, email: user.email });
    return {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        kycStatus: user.kycStatus,
        kycTier: user.kycTier,
        status: user.status,
        createdAt: user.createdAt,
      },
      accessToken,
    };
  }

  async forgotPassword(input: z.infer<typeof forgotPasswordSchema>) {
    // Always succeed to avoid email enumeration; simulation does not send mail.
    const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
    return {
      ok: true,
      simulated: true,
      message: user
        ? "If this email exists, a reset link would be sent. In simulation mode, log in with your current password or change it from settings."
        : "If this email exists, a reset link would be sent.",
    };
  }
}

export const authService = new AuthService();
