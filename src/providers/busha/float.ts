import { bushaClient } from "../../providers/busha/client.js";
import { useBushaLive, simRef } from "../../lib/simulate.js";
import { AppError } from "../../lib/errors.js";

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function unwrapData(raw: unknown): Record<string, unknown> {
  const obj = asRecord(raw);
  const data = asRecord(obj.data);
  return Object.keys(data).length ? data : obj;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

export type TempBankDetails = {
  accountName: string;
  accountNumber: string;
  bankName: string;
  bankCode?: string;
  expiresAt?: string;
};

export type MasterDepositResult = {
  transferId: string;
  quoteId?: string;
  sourceAmount: number;
  /** Net amount credited to Busha after fees (prefer this for Fulus credit). */
  targetAmount: number;
  feeAmount: number;
  bank: TempBankDetails;
  raw: Record<string, unknown>;
  simulated: boolean;
};

export type MasterPayoutResult = {
  transferId: string;
  quoteId?: string;
  amount: number;
  recipientId: string;
  raw: Record<string, unknown>;
  simulated: boolean;
};

function extractBank(transfer: Record<string, unknown>): TempBankDetails {
  const payIn = asRecord(transfer.pay_in);
  const details = asRecord(payIn.recipient_details);
  return {
    accountName: str(details.account_name) ?? str(details.accountName) ?? "Fulus",
    accountNumber: str(details.account_number) ?? str(details.accountNumber) ?? "",
    bankName: str(details.bank_name) ?? str(details.bankName) ?? "Partner Bank",
    bankCode: str(details.bank_code) ?? str(details.bankCode),
    expiresAt: str(payIn.expires_at) ?? str(payIn.expiresAt),
  };
}

function feeFromTransfer(transfer: Record<string, unknown>): number {
  const fees = Array.isArray(transfer.fees) ? transfer.fees : [];
  let total = 0;
  for (const f of fees) {
    const row = asRecord(f);
    const amt = asRecord(row.amount);
    total += num(amt.amount) ?? num(row.amount) ?? 0;
  }
  return total;
}

/**
 * Omnibus (master) Busha NGN helpers — always use profileId: null.
 */
export class BushaFloatService {
  async getMasterNgnBalance(): Promise<number> {
    if (!useBushaLive()) return Number.POSITIVE_INFINITY;
    return this.parseNgnAvailable(await bushaClient.listMasterBalances());
  }

  /** Parse NGN available from a Busha balances response. */
  parseNgnAvailable(raw: unknown): number {
    const obj = asRecord(raw);
    const data = asRecord(obj.data);
    const rows: unknown[] = Array.isArray(obj.data)
      ? (obj.data as unknown[])
      : Array.isArray(data.balances)
        ? (data.balances as unknown[])
        : Array.isArray(obj.balances)
          ? (obj.balances as unknown[])
          : [];
    for (const row of rows) {
      const b = asRecord(row);
      if ((str(b.currency) ?? str(b.code) ?? "").toUpperCase() !== "NGN") continue;
      return (
        num(b.available) ??
        num(b.available_balance) ??
        num(b.balance) ??
        num(asRecord(b.available).amount) ??
        0
      );
    }
    return 0;
  }

  async getCustomerNgnBalance(customerId: string): Promise<number> {
    if (!useBushaLive()) return 0;
    return this.parseNgnAvailable(await bushaClient.listBalances(customerId));
  }

  /** NGN→NGN temp bank deposit that credits the business (master) float. */
  async createMasterNgnDeposit(sourceAmount: number): Promise<MasterDepositResult> {
    if (!(sourceAmount > 0)) throw new AppError("Invalid deposit amount");

    if (!useBushaLive()) {
      const transferId = simRef("TRF");
      return {
        transferId,
        quoteId: simRef("QUO"),
        sourceAmount,
        targetAmount: sourceAmount,
        feeAmount: 0,
        bank: {
          accountName: "Fulus Deposit",
          accountNumber: `70${String(Date.now()).slice(-8)}`,
          bankName: "Demo Microfinance Bank",
          bankCode: "999999",
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        },
        raw: { simulated: true, id: transferId },
        simulated: true,
      };
    }

    const quoteRaw = unwrapData(
      await bushaClient.createQuote(
        {
          source_currency: "NGN",
          target_currency: "NGN",
          source_amount: String(sourceAmount),
          pay_in: { type: "temporary_bank_account" },
        },
        null,
      ),
    );
    const quoteId = str(quoteRaw.id);
    if (!quoteId) throw new AppError("Deposit quote missing id", 502);

    const transfer = unwrapData(await bushaClient.createTransfer({ quote_id: quoteId }, null));
    const transferId = str(transfer.id) ?? str(transfer.reference);
    if (!transferId) throw new AppError("Deposit transfer missing id", 502);

    const bank = extractBank(transfer);
    if (!bank.accountNumber) {
      throw new AppError("Temporary bank account details were not returned", 502);
    }

    const targetAmount =
      num(transfer.target_amount) ?? num(quoteRaw.target_amount) ?? sourceAmount;
    const feeAmount = feeFromTransfer(transfer) || Math.max(0, sourceAmount - targetAmount);

    return {
      transferId,
      quoteId,
      sourceAmount,
      targetAmount,
      feeAmount,
      bank,
      raw: { quote: quoteRaw, transfer },
      simulated: false,
    };
  }

  /** Create ngn_bank recipient on the business profile. */
  async createMasterBankRecipient(input: {
    accountName: string;
    accountNumber: string;
    bankName: string;
    bankCode: string;
  }): Promise<string> {
    if (!useBushaLive()) return simRef("RCP");

    const raw = unwrapData(
      await bushaClient.createRecipient(
        {
          currency: "NGN",
          country_code: "NG",
          type: "ngn_bank",
          bank_name: input.bankName,
          bank_code: input.bankCode,
          account_number: input.accountNumber,
          account_name: input.accountName,
        },
        null,
      ),
    );
    const id = str(raw.id);
    if (!id) throw new AppError("Bank recipient missing id", 502);
    return id;
  }

  async deleteMasterRecipient(recipientId: string) {
    if (!useBushaLive() || recipientId.startsWith("RCP_SIM")) return;
    try {
      await bushaClient.deleteRecipient(recipientId, null);
    } catch {
      // best-effort cleanup
    }
  }

  /** NGN→NGN bank payout from master float to a registered recipient. */
  async payoutFromMaster(input: {
    amount: number;
    accountName: string;
    accountNumber: string;
    bankName: string;
    bankCode: string;
  }): Promise<MasterPayoutResult> {
    if (!(input.amount > 0)) throw new AppError("Invalid payout amount");

    if (!useBushaLive()) {
      return {
        transferId: simRef("TRF"),
        quoteId: simRef("QUO"),
        amount: input.amount,
        recipientId: simRef("RCP"),
        raw: { simulated: true },
        simulated: true,
      };
    }

    const recipientId = await this.createMasterBankRecipient(input);

    const quoteRaw = unwrapData(
      await bushaClient.createQuote(
        {
          source_currency: "NGN",
          target_currency: "NGN",
          source_amount: String(input.amount),
          pay_in: { type: "balance" },
          pay_out: { type: "bank_transfer", recipient_id: recipientId },
        },
        null,
      ),
    );
    const quoteId = str(quoteRaw.id);
    if (!quoteId) throw new AppError("Payout quote missing id", 502);

    const transfer = unwrapData(await bushaClient.createTransfer({ quote_id: quoteId }, null));
    const transferId = str(transfer.id) ?? str(transfer.reference);
    if (!transferId) throw new AppError("Payout transfer missing id", 502);

    return {
      transferId,
      quoteId,
      amount: input.amount,
      recipientId,
      raw: { quote: quoteRaw, transfer },
      simulated: false,
    };
  }

  /**
   * Move NGN from a customer profile balance into the business master float.
   * Uses pay_out:internal with address = public key / business profile id (Busha docs).
   */
  async sweepCustomerNgnToMaster(customerId: string, amount: number): Promise<MasterPayoutResult> {
    if (!(amount > 0)) throw new AppError("Invalid sweep amount");
    if (!useBushaLive()) {
      return {
        transferId: simRef("TRF"),
        amount,
        recipientId: "master",
        raw: { simulated: true, sweep: true },
        simulated: true,
      };
    }

    const { env } = await import("../../config/env.js");
    const address = (env.BUSHA_PUBLIC_KEY || env.BUSHA_PROFILE_ID || "").trim();
    if (!address) {
      throw new AppError(
        "BUSHA_PUBLIC_KEY or BUSHA_PROFILE_ID required for customer→master sweep",
        500,
        "SWEEP_CONFIG",
      );
    }

    try {
      const quoteRaw = unwrapData(
        await bushaClient.createQuote(
          {
            source_currency: "NGN",
            target_currency: "NGN",
            source_amount: String(amount),
            pay_in: { type: "balance" },
            pay_out: { type: "internal", address },
          },
          customerId,
        ),
      );
      const quoteId = str(quoteRaw.id);
      if (!quoteId) throw new AppError("internal sweep quote failed");
      const transfer = unwrapData(await bushaClient.createTransfer({ quote_id: quoteId }, customerId));
      const transferId = str(transfer.id);
      if (!transferId) throw new AppError("internal sweep transfer failed");
      return {
        transferId,
        quoteId,
        amount,
        recipientId: "internal",
        raw: { quote: quoteRaw, transfer, mode: "internal", addressHint: address.slice(0, 8) },
        simulated: false,
      };
    } catch (err) {
      throw new AppError(
        `Customer→master sweep failed: ${err instanceof Error ? err.message : "unknown"}`,
        502,
        "SWEEP_UNSUPPORTED",
      );
    }
  }
}

export const bushaFloatService = new BushaFloatService();
