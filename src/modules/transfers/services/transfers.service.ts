import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { AppError, NotFoundError } from "../../../lib/errors.js";
import { makeReference } from "../../../lib/http.js";

export const beneficiarySchema = z.object({
  type: z.enum(["BANK", "CRYPTO", "BILLER", "FULUS_USER"]),
  label: z.string().min(1),
  currency: z.enum(["NGN", "USD", "SAR"]).optional(),
  accountName: z.string().optional(),
  accountNumber: z.string().optional(),
  bankCode: z.string().optional(),
  bankName: z.string().optional(),
  network: z.string().optional(),
  address: z.string().optional(),
  fulusUserId: z.string().optional(),
  serviceId: z.string().optional(),
  customerRef: z.string().optional(),
});

export const resolveSchema = z.object({
  accountNumber: z.string().min(10),
  bankCode: z.string().min(2),
});

export const fulusTransferSchema = z.object({
  toUserId: z.string().optional(),
  toEmail: z.string().email().optional(),
  currency: z.enum(["NGN", "USD", "SAR"]),
  amount: z.number().positive(),
  narration: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

export const bankTransferSchema = z.object({
  amount: z.number().positive(),
  accountNumber: z.string().min(10),
  accountName: z.string().min(2),
  bankCode: z.string().min(2),
  bankName: z.string().optional(),
  narration: z.string().optional(),
  beneficiaryId: z.string().optional(),
  saveBeneficiary: z.boolean().optional(),
  idempotencyKey: z.string().optional(),
});

const NG_BANKS = [
  { code: "044", name: "Access Bank" },
  { code: "058", name: "GTBank" },
  { code: "057", name: "Zenith Bank" },
  { code: "033", name: "UBA" },
  { code: "011", name: "First Bank" },
  { code: "035", name: "Wema Bank" },
  { code: "070", name: "Fidelity Bank" },
  { code: "232", name: "Sterling Bank" },
  { code: "221", name: "Stanbic IBTC" },
  { code: "50515", name: "Moniepoint" },
  { code: "50211", name: "Kuda" },
  { code: "50746", name: "Opay" },
  { code: "50823", name: "PalmPay" },
];

export class TransfersService {
  listBanks() {
    return NG_BANKS;
  }

  async listBeneficiaries(userId: string) {
    return prisma.beneficiary.findMany({ where: { userId }, orderBy: { updatedAt: "desc" } });
  }

  async createBeneficiary(userId: string, input: z.infer<typeof beneficiarySchema>) {
    return prisma.beneficiary.create({ data: { userId, ...input } });
  }

  async deleteBeneficiary(userId: string, id: string) {
    const row = await prisma.beneficiary.findFirst({ where: { id, userId } });
    if (!row) throw new NotFoundError("Beneficiary not found");
    await prisma.beneficiary.delete({ where: { id } });
    return { deleted: true };
  }

  async resolveAccount(input: z.infer<typeof resolveSchema>) {
    // No live bank name enquiry yet — always return an in-system mock resolve.
    const bank = NG_BANKS.find((b) => b.code === input.bankCode);
    const last4 = input.accountNumber.slice(-4);
    return {
      provider: "mock",
      data: {
        account_number: input.accountNumber,
        account_name: `FULUS MOCK / ${last4}`,
        bank_code: input.bankCode,
        bank_name: bank?.name ?? "Unknown Bank",
        mock: true,
      },
    };
  }

  async transferFulus(userId: string, input: z.infer<typeof fulusTransferSchema>) {
    if (!input.toUserId && !input.toEmail) throw new AppError("Provide toUserId or toEmail");

    if (input.idempotencyKey) {
      const existing = await prisma.transaction.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) return { transaction: existing };
    }

    const recipient = input.toUserId
      ? await prisma.user.findUnique({ where: { id: input.toUserId } })
      : await prisma.user.findUnique({ where: { email: input.toEmail!.toLowerCase() } });
    if (!recipient) throw new NotFoundError("Recipient not found");
    if (recipient.id === userId) throw new AppError("Cannot transfer to yourself");

    const amount = new Prisma.Decimal(input.amount);

    return prisma.$transaction(async (tx) => {
      const fromWallet = await tx.wallet.findUnique({
        where: { userId_currency: { userId, currency: input.currency } },
      });
      const toWallet = await tx.wallet.findUnique({
        where: { userId_currency: { userId: recipient.id, currency: input.currency } },
      });
      if (!fromWallet || !toWallet) throw new NotFoundError("Wallet not found");
      if (new Prisma.Decimal(fromWallet.available).lt(amount)) {
        throw new AppError("Insufficient balance", 400, "INSUFFICIENT_FUNDS");
      }

      const fromAfter = new Prisma.Decimal(fromWallet.available).minus(amount);
      const toAfter = new Prisma.Decimal(toWallet.available).plus(amount);
      const reference = makeReference("P2P");

      const outTx = await tx.transaction.create({
        data: {
          userId,
          type: "TRANSFER",
          status: "SUCCESS",
          amount,
          currency: input.currency,
          reference,
          description: input.narration ?? `Transfer to ${recipient.email}`,
          idempotencyKey: input.idempotencyKey,
          metadata: { direction: "out", counterpartyId: recipient.id },
        },
      });
      const inTx = await tx.transaction.create({
        data: {
          userId: recipient.id,
          type: "TRANSFER",
          status: "SUCCESS",
          amount,
          currency: input.currency,
          reference: makeReference("P2P"),
          description: `Transfer from ${userId}`,
          metadata: { direction: "in", counterpartyId: userId, pairReference: reference },
        },
      });

      await tx.wallet.update({ where: { id: fromWallet.id }, data: { available: fromAfter } });
      await tx.wallet.update({ where: { id: toWallet.id }, data: { available: toAfter } });
      await tx.ledgerEntry.create({
        data: {
          walletId: fromWallet.id,
          transactionId: outTx.id,
          type: "DEBIT",
          amount,
          balanceAfter: fromAfter,
        },
      });
      await tx.ledgerEntry.create({
        data: {
          walletId: toWallet.id,
          transactionId: inTx.id,
          type: "CREDIT",
          amount,
          balanceAfter: toAfter,
        },
      });

      return { transaction: outTx, recipient: { id: recipient.id, email: recipient.email } };
    });
  }

  async transferBank(userId: string, input: z.infer<typeof bankTransferSchema>) {
    if (input.idempotencyKey) {
      const existing = await prisma.transaction.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) {
        const transfer = await prisma.bankTransfer.findUnique({ where: { transactionId: existing.id } });
        return { transaction: existing, transfer };
      }
    }

    const amount = new Prisma.Decimal(input.amount);
    const fee = new Prisma.Decimal(0);
    const total = amount.plus(fee);

    return prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({
        where: { userId_currency: { userId, currency: "NGN" } },
      });
      if (!wallet) throw new NotFoundError("NGN wallet not found");
      if (new Prisma.Decimal(wallet.available).lt(total)) {
        throw new AppError("Insufficient balance", 400, "INSUFFICIENT_FUNDS");
      }

      let beneficiaryId = input.beneficiaryId;
      if (input.saveBeneficiary && !beneficiaryId) {
        const b = await tx.beneficiary.create({
          data: {
            userId,
            type: "BANK",
            label: input.accountName,
            currency: "NGN",
            accountName: input.accountName,
            accountNumber: input.accountNumber,
            bankCode: input.bankCode,
            bankName: input.bankName,
          },
        });
        beneficiaryId = b.id;
      }

      const balanceAfter = new Prisma.Decimal(wallet.available).minus(total);
      const transaction = await tx.transaction.create({
        data: {
          userId,
          type: "WITHDRAWAL",
          status: "SUCCESS",
          amount,
          fee,
          currency: "NGN",
          reference: makeReference("BNK"),
          description: input.narration ?? `Mock bank transfer to ${input.accountNumber}`,
          idempotencyKey: input.idempotencyKey,
          provider: "mock",
          metadata: {
            mock: true,
            accountName: input.accountName,
            accountNumber: input.accountNumber,
            bankCode: input.bankCode,
            bankName: input.bankName,
          },
        },
      });

      await tx.wallet.update({ where: { id: wallet.id }, data: { available: balanceAfter } });
      await tx.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          transactionId: transaction.id,
          type: "DEBIT",
          amount: total,
          balanceAfter,
        },
      });

      const transfer = await tx.bankTransfer.create({
        data: {
          userId,
          transactionId: transaction.id,
          beneficiaryId,
          currency: "NGN",
          amount,
          fee,
          accountName: input.accountName,
          accountNumber: input.accountNumber,
          bankCode: input.bankCode,
          bankName: input.bankName,
          narration: input.narration,
          provider: "mock",
          status: "SUCCESS",
        },
      });

      return { transaction, transfer, mock: true };
    });
  }

  async lookupUser(q: string) {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    return prisma.user.findMany({
      where: {
        OR: [
          { email: { contains: query } },
          { phone: { contains: query } },
          { firstName: { contains: query } },
          { lastName: { contains: query } },
        ],
        status: "ACTIVE",
      },
      take: 10,
      select: { id: true, email: true, firstName: true, lastName: true, phone: true },
    });
  }
}

export const transfersService = new TransfersService();
