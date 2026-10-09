import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../../lib/prisma.js";
import { AppError, NotFoundError } from "../../../lib/errors.js";
import { resolveAvatarAbsPath, saveUserAvatar } from "../../../lib/avatar-storage.js";

export const updateProfileSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().min(8).optional().nullable(),
  /** Base64 or data-URL image for profile photo */
  avatar: z.string().min(40).optional(),
  /** Notification preferences stored on user.flagsJson */
  notifPrefs: z
    .object({
      txPush: z.boolean().optional(),
      txEmail: z.boolean().optional(),
      txSms: z.boolean().optional(),
      login: z.boolean().optional(),
      security: z.boolean().optional(),
      rates: z.boolean().optional(),
      promo: z.boolean().optional(),
      product: z.boolean().optional(),
    })
    .optional(),
  /** Expo push token for this device */
  pushToken: z.string().min(10).max(512).optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

export const closureRequestSchema = z.object({
  reason: z.string().min(3).max(2000),
});

const profileSelect = {
  id: true,
  email: true,
  phone: true,
  firstName: true,
  lastName: true,
  avatarPath: true,
  status: true,
  kycStatus: true,
  kycTier: true,
  dateOfBirth: true,
  nin: true,
  bushaCustomerId: true,
  bushaCustomerStatus: true,
  emailVerifiedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

function withAvatarUrl<T extends { id: string; avatarPath: string | null }>(user: T) {
  const { avatarPath, ...rest } = user;
  return {
    ...rest,
    hasAvatar: Boolean(avatarPath),
    /** Client builds full URL as `${API_URL}/avatars/${id}` */
    avatarUrl: avatarPath ? `/avatars/${user.id}` : null,
  };
}

export class UsersService {
  async getMe(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: profileSelect,
    });

    if (!user) throw new NotFoundError("User not found");
    return withAvatarUrl(user);
  }

  async updateMe(userId: string, input: z.infer<typeof updateProfileSchema>) {
    const existing = await prisma.user.findUnique({
      where: { id: userId },
      select: { kycTier: true, kycStatus: true, flagsJson: true, firstName: true, lastName: true },
    });
    if (!existing) throw new NotFoundError("User not found");

    const nameLocked =
      existing.kycTier >= 1 || String(existing.kycStatus).toUpperCase() === "APPROVED";
    if (nameLocked && (input.firstName !== undefined || input.lastName !== undefined)) {
      const sameFirst =
        input.firstName === undefined || input.firstName === (existing.firstName ?? undefined);
      const sameLast =
        input.lastName === undefined || input.lastName === (existing.lastName ?? undefined);
      if (!sameFirst || !sameLast) {
        throw new AppError(
          "Name can’t be changed after identity verification. Contact support if you need a correction.",
          400,
          "NAME_LOCKED",
        );
      }
    }

    let avatarPath: string | undefined;
    if (input.avatar) {
      avatarPath = await saveUserAvatar(userId, input.avatar);
    }

    const prevFlags =
      existing.flagsJson && typeof existing.flagsJson === "object" && !Array.isArray(existing.flagsJson)
        ? (existing.flagsJson as Record<string, unknown>)
        : {};
    let nextFlags: Record<string, unknown> | undefined;
    if (input.notifPrefs || input.pushToken) {
      const tokens = Array.isArray(prevFlags.pushTokens)
        ? [...(prevFlags.pushTokens as string[])]
        : [];
      if (input.pushToken && !tokens.includes(input.pushToken)) {
        tokens.push(input.pushToken);
        if (tokens.length > 10) tokens.splice(0, tokens.length - 10);
      }
      nextFlags = {
        ...prevFlags,
        ...(input.notifPrefs
          ? {
              notifPrefs: {
                ...(typeof prevFlags.notifPrefs === "object" && prevFlags.notifPrefs
                  ? (prevFlags.notifPrefs as Record<string, unknown>)
                  : {}),
                ...input.notifPrefs,
              },
            }
          : {}),
        ...(input.pushToken ? { pushTokens: tokens } : {}),
      };
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(input.firstName !== undefined && !nameLocked ? { firstName: input.firstName } : {}),
        ...(input.lastName !== undefined && !nameLocked ? { lastName: input.lastName } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(avatarPath !== undefined ? { avatarPath } : {}),
        ...(nextFlags !== undefined
          ? { flagsJson: nextFlags as Prisma.InputJsonValue }
          : {}),
      },
      select: profileSelect,
    });
    return withAvatarUrl(user);
  }

  async getAvatarFile(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { avatarPath: true },
    });
    if (!user?.avatarPath) throw new NotFoundError("Avatar not found");
    const abs = resolveAvatarAbsPath(user.avatarPath);
    return { abs, avatarPath: user.avatarPath };
  }

  async changePassword(userId: string, input: z.infer<typeof changePasswordSchema>) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError("User not found");
    const valid = await bcrypt.compare(input.currentPassword, user.passwordHash);
    if (!valid) throw new AppError("Current password is incorrect", 400, "INVALID_PASSWORD");
    const passwordHash = await bcrypt.hash(input.newPassword, 12);
    await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    return { ok: true };
  }

  async listInbox(userId: string) {
    return prisma.inboxMessage.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }

  async markInboxRead(userId: string, id: string) {
    const row = await prisma.inboxMessage.findFirst({ where: { id, userId } });
    if (!row) throw new NotFoundError("Message not found");
    return prisma.inboxMessage.update({ where: { id }, data: { read: true } });
  }

  async requestClosure(userId: string, input: z.infer<typeof closureRequestSchema>) {
    const pending = await prisma.closureRequest.findFirst({
      where: { userId, status: "PENDING" },
    });
    if (pending) {
      return { ok: true, request: pending, duplicate: true };
    }

    const request = await prisma.closureRequest.create({
      data: { userId, reason: input.reason.trim() },
    });

    await prisma.inboxMessage.create({
      data: {
        userId,
        title: "Wallet closure requested",
        body: `We received your closure request. Our team will review it within 30 days. Reference: ${request.id.slice(-8).toUpperCase()}`,
        category: "account",
      },
    });

    return { ok: true, request, duplicate: false };
  }
}

export const usersService = new UsersService();
