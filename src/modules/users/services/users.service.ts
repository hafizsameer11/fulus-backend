import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../../../lib/prisma.js";
import { AppError, NotFoundError } from "../../../lib/errors.js";
import { simulateProviders } from "../../../lib/simulate.js";

export const updateProfileSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().min(8).optional().nullable(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
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
    let rows = await prisma.inboxMessage.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    if (!rows.length && simulateProviders()) {
      await prisma.inboxMessage.createMany({
        data: [
          {
            userId,
            title: "Welcome to Fulus",
            body: "Your NGN, USD and SAR wallets are ready. Swap at admin FX rates anytime.",
            category: "system",
          },
          {
            userId,
            title: "Providers in simulation mode",
            body: "Cards, bills, crypto and eSIM succeed locally until live provider keys are configured.",
            category: "system",
          },
        ],
      });
      rows = await prisma.inboxMessage.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
    }
    return rows;
  }

  async markInboxRead(userId: string, id: string) {
    const row = await prisma.inboxMessage.findFirst({ where: { id, userId } });
    if (!row) throw new NotFoundError("Message not found");
    return prisma.inboxMessage.update({ where: { id }, data: { read: true } });
  }
}

export const usersService = new UsersService();
