import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { AppError, NotFoundError } from "../../../lib/errors.js";
import { makeReference } from "../../../lib/http.js";

export const createDepositSchema = z.object({
  currency: z.enum(["NGN"]).default("NGN"),
  amount: z.number().positive().optional(),
});

function vaNumber(userId: string) {
  const digits = userId.replace(/\D/g, "").slice(-8).padStart(8, "0");
  return `90${digits}21`;
}

export class DepositsService {
  async ensureVirtualAccount(userId: string) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const existing = await prisma.virtualAccount.findUnique({
      where: { userId_currency_provider: { userId, currency: "NGN", provider: "fulus" } },
    });
    if (existing) return existing;

    const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email;
    return prisma.virtualAccount.create({
      data: {
        userId,
        currency: "NGN",
        provider: "fulus",
        accountName: `Fulus / ${name}`,
        accountNumber: vaNumber(userId),
        bankName: "Wema Bank",
        bankCode: "035",
        status: "ACTIVE",
      },
    });
  }

  async createBankDeposit(userId: string, input: z.infer<typeof createDepositSchema>) {
    if (input.currency !== "NGN") {
      throw new AppError("USD and SAR are virtual — fund via swap from NGN", 400, "VIRTUAL_CURRENCY");
    }

    const va = await this.ensureVirtualAccount(userId);
    const deposit = await prisma.deposit.create({
      data: {
        userId,
        method: "VIRTUAL_ACCOUNT",
        currency: "NGN",
        amount: input.amount,
        status: "PENDING",
        provider: "fulus",
        instructions: {
          bankName: va.bankName,
          accountName: va.accountName,
          accountNumber: va.accountNumber,
          bankCode: va.bankCode,
          reference: makeReference("DEP"),
        },
      },
    });

    return { deposit, virtualAccount: va };
  }

  async list(userId: string) {
    return prisma.deposit.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  }

  /** Dev/admin helper: confirm a pending NGN deposit and credit available balance. */
  async confirm(depositId: string, amount?: number) {
    const deposit = await prisma.deposit.findUnique({ where: { id: depositId } });
    if (!deposit) throw new NotFoundError("Deposit not found");
    if (deposit.status !== "PENDING") throw new AppError("Deposit already settled");

    const creditAmount = new Prisma.Decimal(amount ?? deposit.amount ?? 0);
    if (creditAmount.lte(0)) throw new AppError("Amount required to confirm deposit");

    return prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({
        where: { userId_currency: { userId: deposit.userId, currency: deposit.currency } },
      });
      if (!wallet) throw new NotFoundError("Wallet not found");

      const balanceAfter = new Prisma.Decimal(wallet.available).plus(creditAmount);
      const transaction = await tx.transaction.create({
        data: {
          userId: deposit.userId,
          type: "DEPOSIT",
          status: "SUCCESS",
          amount: creditAmount,
          currency: deposit.currency,
          reference: makeReference("DEP"),
          description: "Bank deposit confirmed",
          provider: "fulus",
        },
      });

      await tx.wallet.update({ where: { id: wallet.id }, data: { available: balanceAfter } });
      await tx.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          transactionId: transaction.id,
          type: "CREDIT",
          amount: creditAmount,
          balanceAfter,
          description: "Bank deposit",
        },
      });

      const updated = await tx.deposit.update({
        where: { id: deposit.id },
        data: {
          status: "SUCCESS",
          amount: creditAmount,
          transactionId: transaction.id,
          confirmedAt: new Date(),
        },
      });

      return { deposit: updated, transaction };
    });
  }
}

export const depositsService = new DepositsService();
