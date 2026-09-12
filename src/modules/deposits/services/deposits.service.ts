import { z } from "zod";
import { prisma } from "../../../lib/prisma.js";
import { AppError } from "../../../lib/errors.js";
import { makeReference } from "../../../lib/http.js";
import { walletService } from "../../wallet/services/wallet.service.js";

export const createDepositSchema = z.object({
  currency: z.enum(["NGN"]).default("NGN"),
  /** Required — no live bank yet, so we settle a mock credit immediately. */
  amount: z.number().positive().max(5_000_000),
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

  /**
   * Mock bank deposit: credits the user's NGN wallet immediately and returns
   * a real wallet transaction (no external bank / VA webhook yet).
   */
  async createBankDeposit(userId: string, input: z.infer<typeof createDepositSchema>) {
    if (input.currency !== "NGN") {
      throw new AppError("USD and SAR are virtual — fund via swap from NGN", 400, "VIRTUAL_CURRENCY");
    }

    const va = await this.ensureVirtualAccount(userId);
    const reference = makeReference("DEP");

    const transaction = await walletService.credit({
      userId,
      currency: "NGN",
      amount: input.amount,
      type: "DEPOSIT",
      description: `Mock bank deposit · ${va.bankName}`,
      provider: "mock",
      providerRef: reference,
      metadata: {
        mock: true,
        bankName: va.bankName,
        accountNumber: va.accountNumber,
      },
    });

    const deposit = await prisma.deposit.create({
      data: {
        userId,
        method: "VIRTUAL_ACCOUNT",
        currency: "NGN",
        amount: input.amount,
        status: "SUCCESS",
        provider: "mock",
        transactionId: transaction.id,
        confirmedAt: new Date(),
        instructions: {
          bankName: va.bankName,
          accountName: va.accountName,
          accountNumber: va.accountNumber,
          bankCode: va.bankCode,
          reference,
          mock: true,
        },
      },
    });

    return { deposit, transaction, virtualAccount: va, mock: true };
  }

  async list(userId: string) {
    return prisma.deposit.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  }

  /**
   * Admin helper kept for older pending rows — settles with a real credit.
   */
  async confirm(depositId: string, amount?: number) {
    const deposit = await prisma.deposit.findUnique({ where: { id: depositId } });
    if (!deposit) throw new AppError("Deposit not found", 404, "NOT_FOUND");
    if (deposit.status !== "PENDING") throw new AppError("Deposit already settled");

    const creditAmount = Number(amount ?? deposit.amount ?? 0);
    if (!(creditAmount > 0)) throw new AppError("Amount required to confirm deposit");

    const transaction = await walletService.credit({
      userId: deposit.userId,
      currency: deposit.currency,
      amount: creditAmount,
      type: "DEPOSIT",
      description: "Bank deposit confirmed",
      provider: "mock",
    });

    const updated = await prisma.deposit.update({
      where: { id: deposit.id },
      data: {
        status: "SUCCESS",
        amount: creditAmount,
        transactionId: transaction.id,
        confirmedAt: new Date(),
        provider: "mock",
      },
    });

    return { deposit: updated, transaction, mock: true };
  }
}

export const depositsService = new DepositsService();
