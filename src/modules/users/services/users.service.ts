import bcrypt from "bcryptjs";
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
    let avatarPath: string | undefined;
    if (input.avatar) {
      avatarPath = await saveUserAvatar(userId, input.avatar);
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
        ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(avatarPath !== undefined ? { avatarPath } : {}),
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
