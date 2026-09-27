import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { AppError, NotFoundError, sanitizePublicCopy } from "../../../lib/errors.js";
import { makeReference } from "../../../lib/http.js";
import { useBushaLive } from "../../../lib/simulate.js";
import { walletService } from "../../wallet/services/wallet.service.js";

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

/** What the beneficiary must receive (Busha net minimum is ₦499). */
export const MIN_BANK_RECEIVE_NGN = 499;

export const bankTransferSchema = z.object({
  /** Amount the bank recipient receives (not including payout fee). */
  amount: z
    .number()
    .min(MIN_BANK_RECEIVE_NGN, `Minimum bank payout is ₦${MIN_BANK_RECEIVE_NGN} (plus fees). Try at least ₦610.`),
  accountNumber: z.string().min(10),
  accountName: z.string().min(2),
  bankCode: z.string().min(2),
  bankName: z.string().optional(),
  narration: z.string().optional(),
  beneficiaryId: z.string().optional(),
  saveBeneficiary: z.boolean().optional(),
  idempotencyKey: z.string().optional(),
});

export const bankQuoteSchema = z.object({
  amount: z.number().positive(),
  accountNumber: z.string().min(10),
  accountName: z.string().min(2).optional(),
  bankCode: z.string().min(2),
  bankName: z.string().optional(),
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const obj = asRecord(value);
  if (Array.isArray(obj.data)) return obj.data;
  if (Array.isArray(obj.banks)) return obj.banks;
  return [];
}

export class TransfersService {
  async listBanks() {
    if (useBushaLive()) {
      try {
        const { bushaClient } = await import("../../../providers/busha/client.js");
        const raw = await bushaClient.listBanks({ currency: "NGN", country: "NG" });
        const rows = asList(raw)
          .map((row) => {
            const b = asRecord(row);
            const code = String(b.code ?? b.bank_code ?? b.id ?? "").trim();
            const name = String(b.name ?? b.bank_name ?? "").trim();
            if (!code || !name) return null;
            return { code, name };
          })
          .filter((b): b is { code: string; name: string } => Boolean(b));
        if (rows.length > 0) return rows;
      } catch {
        // Fall through to static list
      }
    }
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
    const fallbackBank = NG_BANKS.find((b) => b.code === input.bankCode);

    if (useBushaLive()) {
      try {
        const { bushaClient } = await import("../../../providers/busha/client.js");
        let raw: unknown;
        try {
          raw = await bushaClient.resolveBankAccount({
            bank_code: input.bankCode,
            account_number: input.accountNumber,
            channel: "bank_transfer",
          });
        } catch {
          // Docs sample uses mobile_money; NGN banks should use bank_transfer first.
          raw = await bushaClient.resolveBankAccount({
            bank_code: input.bankCode,
            account_number: input.accountNumber,
            channel: "mobile_money",
          });
        }
        const data = asRecord(asRecord(raw).data ?? raw);
        const accountName = String(
          data.account_name ?? data.accountName ?? data.name ?? "",
        ).trim();
        if (!accountName) {
          throw new AppError("Could not resolve account name", 400, "RESOLVE_FAILED");
        }
        return {
          provider: "busha",
          live: true,
          data: {
            account_number: String(data.account_number ?? input.accountNumber),
            account_name: accountName,
            bank_code: String(data.bank_code ?? input.bankCode),
            bank_name: String(data.bank_name ?? fallbackBank?.name ?? "Bank"),
          },
        };
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new AppError(
          sanitizePublicCopy(
            err instanceof Error ? err.message : "Could not resolve bank account",
            "Could not resolve bank account",
          ),
          400,
          "RESOLVE_FAILED",
        );
      }
    }

    const last4 = input.accountNumber.slice(-4);
    return {
      provider: "mock",
      live: false,
      data: {
        account_number: input.accountNumber,
        account_name: `FULUS MOCK / ${last4}`,
        bank_code: input.bankCode,
        bank_name: fallbackBank?.name ?? "Unknown Bank",
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
          description: sanitizePublicCopy(input.narration ?? `Transfer to ${recipient.email}`) || undefined,
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
          description: "Transfer received",
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

  /**
   * Preview fee/debit for a bank payout. `amount` = what the recipient should receive.
   */
  async quoteBankTransfer(userId: string, input: z.infer<typeof bankQuoteSchema>) {
    const receiveAmount = Number(input.amount);
    if (receiveAmount + 1e-9 < MIN_BANK_RECEIVE_NGN) {
      throw new AppError(
        `Minimum bank payout is ₦${MIN_BANK_RECEIVE_NGN} (plus fees). Try at least ₦610.`,
        400,
        "MIN_PAYOUT",
      );
    }

    const bankName = input.bankName || NG_BANKS.find((b) => b.code === input.bankCode)?.name || "Bank";
    const { bushaFloatService } = await import("../../../providers/busha/float.js");
    const quote = await bushaFloatService.quoteMasterBankPayout({
      targetAmount: receiveAmount,
      accountName: input.accountName || "Beneficiary",
      accountNumber: input.accountNumber,
      bankName,
      bankCode: input.bankCode,
    });

    const wallet = await prisma.wallet.findUnique({
      where: { userId_currency: { userId, currency: "NGN" } },
    });
    const available = Number(wallet?.available ?? 0);

    return {
      receiveAmount: quote.targetAmount,
      feeAmount: quote.feeAmount,
      debitAmount: quote.sourceAmount,
      minReceive: MIN_BANK_RECEIVE_NGN,
      sufficient: available + 1e-9 >= quote.sourceAmount,
      available,
      live: useBushaLive(),
      simulated: quote.simulated,
    };
  }

  async transferBank(userId: string, input: z.infer<typeof bankTransferSchema>) {
    if (input.idempotencyKey) {
      const existing = await prisma.transaction.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) {
        const transfer = await prisma.bankTransfer.findUnique({ where: { transactionId: existing.id } });
        return { transaction: existing, transfer };
      }
    }

    const receiveAmount = Number(input.amount);
    const live = useBushaLive();
    const bankName = input.bankName || NG_BANKS.find((b) => b.code === input.bankCode)?.name || "Bank";

    // Quote first so we know Busha source (debit) + fee — amount is what the bank receives.
    const { bushaFloatService } = await import("../../../providers/busha/float.js");
    const quote = await bushaFloatService.quoteMasterBankPayout({
      targetAmount: receiveAmount,
      accountName: input.accountName,
      accountNumber: input.accountNumber,
      bankName,
      bankCode: input.bankCode,
    });

    const debitAmount = new Prisma.Decimal(quote.sourceAmount);
    const fee = new Prisma.Decimal(quote.feeAmount);
    const receive = new Prisma.Decimal(quote.targetAmount);

    const debit = await prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({
        where: { userId_currency: { userId, currency: "NGN" } },
      });
      if (!wallet) throw new NotFoundError("NGN wallet not found");
      if (new Prisma.Decimal(wallet.available).lt(debitAmount)) {
        throw new AppError(
          `Insufficient balance. You need ₦${quote.sourceAmount.toLocaleString()} (recipient ₦${quote.targetAmount.toLocaleString()} + fee ₦${quote.feeAmount.toLocaleString()}).`,
          400,
          "INSUFFICIENT_FUNDS",
        );
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

      const balanceAfter = new Prisma.Decimal(wallet.available).minus(debitAmount);
      const transaction = await tx.transaction.create({
        data: {
          userId,
          type: "WITHDRAWAL",
          status: live ? "PENDING" : "SUCCESS",
          amount: receive,
          fee,
          currency: "NGN",
          reference: makeReference("BNK"),
          description:
            sanitizePublicCopy(input.narration ?? `Bank transfer to ${input.accountNumber}`) || undefined,
          idempotencyKey: input.idempotencyKey,
          provider: live ? "busha" : "mock",
          metadata: {
            accountName: input.accountName,
            accountNumber: input.accountNumber,
            bankCode: input.bankCode,
            bankName: input.bankName,
            masterFloatPayout: live,
            receiveAmount: quote.targetAmount,
            debitAmount: quote.sourceAmount,
            feeAmount: quote.feeAmount,
            quoteId: quote.quoteId,
          },
        },
      });

      await tx.wallet.update({ where: { id: wallet.id }, data: { available: balanceAfter } });
      await tx.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          transactionId: transaction.id,
          type: "DEBIT",
          amount: debitAmount,
          balanceAfter,
        },
      });

      const transfer = await tx.bankTransfer.create({
        data: {
          userId,
          transactionId: transaction.id,
          beneficiaryId,
          currency: "NGN",
          amount: receive,
          fee,
          accountName: input.accountName,
          accountNumber: input.accountNumber,
          bankCode: input.bankCode,
          bankName: input.bankName,
          narration: input.narration,
          provider: live ? "busha" : "mock",
          status: live ? "PENDING" : "SUCCESS",
        },
      });

      return { transaction, transfer, beneficiaryId };
    });

    if (!live || quote.simulated) {
      return {
        ...debit,
        mock: !live,
        live: false,
        receiveAmount: quote.targetAmount,
        feeAmount: quote.feeAmount,
        debitAmount: quote.sourceAmount,
      };
    }

    try {
      const { transferId } = await bushaFloatService.executeQuotedPayout(quote.quoteId);

      await prisma.bankTransfer.update({
        where: { id: debit.transfer.id },
        data: {
          providerRef: transferId,
          status: "PENDING",
          fee,
        },
      });
      await prisma.transaction.update({
        where: { id: debit.transaction.id },
        data: {
          providerRef: transferId,
          status: "PENDING",
          fee,
          metadata: {
            ...(typeof debit.transaction.metadata === "object" && debit.transaction.metadata
              ? (debit.transaction.metadata as object)
              : {}),
            masterPayout: {
              transferId,
              recipientId: quote.recipientId,
              quoteId: quote.quoteId,
              sourceAmount: quote.sourceAmount,
              targetAmount: quote.targetAmount,
              feeAmount: quote.feeAmount,
            },
          },
        },
      });

      const transfer = await prisma.bankTransfer.findUniqueOrThrow({ where: { id: debit.transfer.id } });
      const transaction = await prisma.transaction.findUniqueOrThrow({ where: { id: debit.transaction.id } });
      return {
        transaction,
        transfer,
        mock: false,
        live: true,
        receiveAmount: quote.targetAmount,
        feeAmount: quote.feeAmount,
        debitAmount: quote.sourceAmount,
      };
    } catch (error) {
      await walletService.credit({
        userId,
        currency: "NGN",
        amount: quote.sourceAmount,
        type: "ADJUSTMENT",
        description: `Refund failed bank withdrawal ${debit.transaction.reference}`,
        provider: "busha",
        providerRef: `${debit.transaction.id}_payout_refund`,
      });
      await prisma.bankTransfer.update({
        where: { id: debit.transfer.id },
        data: { status: "FAILED" },
      });
      await prisma.transaction.update({
        where: { id: debit.transaction.id },
        data: { status: "FAILED" },
      });

      const { mapBushaPayoutError } = await import("../../../providers/busha/float.js");
      throw mapBushaPayoutError(error, receiveAmount);
    }
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
