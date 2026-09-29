import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../../../lib/prisma.js";
import { AppError } from "../../../lib/errors.js";

export const patchSecuritySchema = z.object({
  transactionPin: z.string().regex(/^\d{4,6}$/).optional(),
  transactionPinEnabled: z.boolean().optional(),
  biometricEnabled: z.boolean().optional(),
  cryptoWhitelistOnly: z.boolean().optional(),
  cryptoWithdrawalLockHours: z.union([z.literal(0), z.literal(24)]).optional(),
  cryptoAntiPhishingCode: z.string().min(1).max(32).nullable().optional(),
});

function publicSecurity(row: {
  transactionPinHash: string | null;
  transactionPinEnabled: boolean;
  biometricEnabled: boolean;
  cryptoWhitelistOnly: boolean;
  cryptoWithdrawalLockHours: number;
  cryptoAntiPhishingCode: string | null;
  cryptoSecurityUpdatedAt: Date | null;
}) {
  return {
    hasTransactionPin: Boolean(row.transactionPinHash),
    transactionPinEnabled: row.transactionPinEnabled,
    biometricEnabled: row.biometricEnabled,
    cryptoWhitelistOnly: row.cryptoWhitelistOnly,
    cryptoWithdrawalLockHours: row.cryptoWithdrawalLockHours,
    cryptoAntiPhishingEnabled: Boolean(row.cryptoAntiPhishingCode?.trim()),
    cryptoAntiPhishingCode: row.cryptoAntiPhishingCode,
    cryptoSecurityUpdatedAt: row.cryptoSecurityUpdatedAt,
  };
}

async function ensureSettings(userId: string) {
  return prisma.userSecuritySettings.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
}

export class SecurityService {
  async getSecurity(userId: string) {
    const row = await ensureSettings(userId);
    return publicSecurity(row);
  }

  async patchSecurity(userId: string, input: z.infer<typeof patchSecuritySchema>) {
    const existing = await ensureSettings(userId);
    const data: {
      transactionPinHash?: string;
      transactionPinEnabled?: boolean;
      biometricEnabled?: boolean;
      cryptoWhitelistOnly?: boolean;
      cryptoWithdrawalLockHours?: number;
      cryptoAntiPhishingCode?: string | null;
      cryptoSecurityUpdatedAt?: Date;
    } = {};

    if (input.transactionPin !== undefined) {
      data.transactionPinHash = await bcrypt.hash(input.transactionPin, 12);
      data.transactionPinEnabled = true;
    }
    if (input.transactionPinEnabled !== undefined) {
      if (input.transactionPinEnabled && !existing.transactionPinHash) {
        throw new AppError("Set a transaction PIN first", 400, "PIN_REQUIRED");
      }
      data.transactionPinEnabled = input.transactionPinEnabled;
    }
    if (input.biometricEnabled !== undefined) data.biometricEnabled = input.biometricEnabled;

    const cryptoTouched =
      input.cryptoWhitelistOnly !== undefined ||
      input.cryptoWithdrawalLockHours !== undefined ||
      input.cryptoAntiPhishingCode !== undefined;

    if (input.cryptoWhitelistOnly !== undefined) data.cryptoWhitelistOnly = input.cryptoWhitelistOnly;
    if (input.cryptoWithdrawalLockHours !== undefined) {
      data.cryptoWithdrawalLockHours = input.cryptoWithdrawalLockHours;
    }
    if (input.cryptoAntiPhishingCode !== undefined) {
      data.cryptoAntiPhishingCode = input.cryptoAntiPhishingCode?.trim() || null;
    }
    if (cryptoTouched) data.cryptoSecurityUpdatedAt = new Date();

    const row = await prisma.userSecuritySettings.update({
      where: { userId },
      data,
    });
    return publicSecurity(row);
  }

  async getCryptoSecurityForUser(userId: string) {
    const row = await ensureSettings(userId);
    return {
      whitelistOnly: row.cryptoWhitelistOnly,
      withdrawalLockHours: row.cryptoWithdrawalLockHours,
      antiPhishingCode: row.cryptoAntiPhishingCode,
      antiPhishingEnabled: Boolean(row.cryptoAntiPhishingCode?.trim()),
      updatedAt: row.cryptoSecurityUpdatedAt,
    };
  }

  /** When PIN is enabled, `transactionPin` (4–6 digits) is required on bank/Fulus transfers. */
  async assertTransactionPin(userId: string, transactionPin?: string) {
    const row = await ensureSettings(userId);
    if (!row.transactionPinEnabled || !row.transactionPinHash) return;
    if (!transactionPin) {
      throw new AppError("Transaction PIN required", 401, "PIN_REQUIRED");
    }
    const valid = await bcrypt.compare(transactionPin, row.transactionPinHash);
    if (!valid) {
      throw new AppError("Invalid transaction PIN", 403, "PIN_INVALID");
    }
  }

  async assertCryptoSendAllowed(userId: string, address: string) {
    const row = await ensureSettings(userId);

    if (row.cryptoWithdrawalLockHours > 0 && row.cryptoSecurityUpdatedAt) {
      const lockUntil = row.cryptoSecurityUpdatedAt.getTime() + row.cryptoWithdrawalLockHours * 60 * 60 * 1000;
      if (Date.now() < lockUntil) {
        throw new AppError(
          `Withdrawals are locked for ${row.cryptoWithdrawalLockHours} hours after security changes`,
          403,
          "WITHDRAWAL_LOCKED",
        );
      }
    }

    if (!row.cryptoWhitelistOnly) return;

    const normalized = address.trim().toLowerCase();
    const whitelisted = await prisma.beneficiary.findMany({
      where: { userId, type: "CRYPTO", address: { not: null } },
      select: { address: true },
    });
    const ok = whitelisted.some((b) => (b.address ?? "").trim().toLowerCase() === normalized);
    if (!ok) {
      throw new AppError("Address not on your crypto whitelist", 403, "WHITELIST_ONLY");
    }
  }
}

export const securityService = new SecurityService();
