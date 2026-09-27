import { Prisma, type TransactionType, type WalletCurrency } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { AppError, NotFoundError, sanitizePublicCopy } from "../../../lib/errors.js";
import { makeReference } from "../../../lib/http.js";

function scrubDescription(description?: string | null) {
  return sanitizePublicCopy(description) || undefined;
}

function scrubTx<T extends { description?: string | null }>(row: T): T {
  if (!row?.description) return row;
  return { ...row, description: scrubDescription(row.description) ?? null };
}

export class WalletService {
  async listWallets(userId: string) {
    return prisma.wallet.findMany({
      where: { userId },
      orderBy: { currency: "asc" },
    });
  }

  async getWallet(userId: string, currency: WalletCurrency) {
    const wallet = await prisma.wallet.findUnique({
      where: { userId_currency: { userId, currency } },
    });
    if (!wallet) throw new NotFoundError(`Wallet ${currency} not found`);
    return wallet;
  }

  async listTransactions(userId: string, take = 50) {
    const rows = await prisma.transaction.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take,
    });
    return rows.map(scrubTx);
  }

  async getTransaction(userId: string, id: string) {
    const tx = await prisma.transaction.findFirst({
      where: { id, userId },
      include: { swap: true, deposit: true, bankTransfer: true, billPayment: true },
    });
    if (!tx) throw new NotFoundError("Transaction not found");
    return scrubTx(tx);
  }

  async credit(params: {
    userId: string;
    currency: WalletCurrency;
    amount: Prisma.Decimal | number | string;
    type: TransactionType;
    description?: string;
    provider?: string;
    providerRef?: string;
    metadata?: Prisma.InputJsonValue;
  }) {
    const amount = new Prisma.Decimal(params.amount);
    if (amount.lte(0)) throw new AppError("Amount must be positive");
    const description = scrubDescription(params.description);

    return prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({
        where: { userId_currency: { userId: params.userId, currency: params.currency } },
      });
      if (!wallet) throw new NotFoundError("Wallet not found");

      const balanceAfter = new Prisma.Decimal(wallet.available).plus(amount);
      const transaction = await tx.transaction.create({
        data: {
          userId: params.userId,
          type: params.type,
          status: "SUCCESS",
          amount,
          currency: params.currency,
          reference: makeReference("TX"),
          provider: params.provider,
          providerRef: params.providerRef,
          description,
          metadata: params.metadata,
        },
      });

      await tx.wallet.update({
        where: { id: wallet.id },
        data: { available: balanceAfter },
      });

      await tx.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          transactionId: transaction.id,
          type: "CREDIT",
          amount,
          balanceAfter,
          description,
        },
      });

      return transaction;
    });
  }

  async debit(params: {
    userId: string;
    currency: WalletCurrency;
    amount: Prisma.Decimal | number | string;
    type: TransactionType;
    description?: string;
    provider?: string;
    providerRef?: string;
    metadata?: Prisma.InputJsonValue;
  }) {
    const amount = new Prisma.Decimal(params.amount);
    if (amount.lte(0)) throw new AppError("Amount must be positive");
    const description = scrubDescription(params.description);

    return prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({
        where: { userId_currency: { userId: params.userId, currency: params.currency } },
      });
      if (!wallet) throw new NotFoundError("Wallet not found");

      const available = new Prisma.Decimal(wallet.available);
      if (available.lt(amount)) throw new AppError("Insufficient balance", 400, "INSUFFICIENT_FUNDS");

      const balanceAfter = available.minus(amount);
      const transaction = await tx.transaction.create({
        data: {
          userId: params.userId,
          type: params.type,
          status: "SUCCESS",
          amount,
          currency: params.currency,
          reference: makeReference("TX"),
          provider: params.provider,
          providerRef: params.providerRef,
          description,
          metadata: params.metadata,
        },
      });

      await tx.wallet.update({
        where: { id: wallet.id },
        data: { available: balanceAfter },
      });

      await tx.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          transactionId: transaction.id,
          type: "DEBIT",
          amount,
          balanceAfter,
          description,
        },
      });

      return transaction;
    });
  }
}

export const walletService = new WalletService();
