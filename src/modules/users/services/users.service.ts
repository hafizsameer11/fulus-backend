import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../../../lib/prisma.js";
import { AppError, NotFoundError } from "../../../lib/errors.js";

export const updateProfileSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().min(8).optional().nullable(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

export const closureRequestSchema = z.object({
  reason: z.string().min(3).max(2000),
});

export class UsersService {
  async getMe(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        phone: true,
        firstName: true,
        lastName: true,
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
      },
    });

    if (!user) throw new NotFoundError("User not found");
    return user;
  }

  async updateMe(userId: string, input: z.infer<typeof updateProfileSchema>) {
    return prisma.user.update({
      where: { id: userId },
      data: {
        ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
        ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
      },
      select: {
        id: true,
        email: true,
        phone: true,
        firstName: true,
        lastName: true,
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
      },
    });
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
