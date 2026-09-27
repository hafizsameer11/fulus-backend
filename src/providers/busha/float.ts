import { bushaClient } from "../../providers/busha/client.js";
import { useBushaLive, simRef } from "../../lib/simulate.js";
import { AppError, sanitizePublicCopy } from "../../lib/errors.js";

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

export type MasterPayoutQuote = {
  quoteId: string;
  recipientId: string;
  /** Debited from master float (includes Busha fee). */
  sourceAmount: number;
  /** Amount the bank recipient receives. */
  targetAmount: number;
  feeAmount: number;
  raw: Record<string, unknown>;
  simulated: boolean;
};

export type MasterPayoutResult = MasterPayoutQuote & {
  transferId: string;
  /** @deprecated use targetAmount — kept for callers that expect `amount` = receive. */
  amount: number;
};

/** Approximate Busha NGN bank payout fee when simulating (₦100 + 7.5% VAT). */
export const SIM_BANK_PAYOUT_FEE_NGN = 107.5;
export const MIN_BUSHA_BANK_RECEIVE_NGN = 499;

/** Never surface vendor brand names in bank details shown to users. */
function scrubVendorBrand(value: string | undefined): string | undefined {
  if (!value) return value;
  return sanitizePublicCopy(value) || undefined;
}

function extractQuoteFee(quote: Record<string, unknown>, sourceAmount: number, targetAmount: number): number {
  const fees = quote.fees ?? quote.fee ?? asRecord(quote.meta).fees;
  if (Array.isArray(fees)) {
    let sum = 0;
    for (const row of fees) {
      const f = asRecord(row);
      const n = num(f.amount ?? f.value ?? f.fee);
      if (n != null) sum += n;
    }
    if (sum > 0) return sum;
  }
  const single = num(fees);
  if (single != null && single > 0) return single;
  const named = num(quote.fee_amount) ?? num(quote.total_fee);
  if (named != null && named > 0) return named;
  return Math.max(0, +(sourceAmount - targetAmount).toFixed(2));
}

/** Prefer Busha's field validation reasons (e.g. minimum payout) over generic provider copy. */
export function mapBushaPayoutError(err: unknown, targetAmount?: number): AppError {
  if (err instanceof AppError && err.code !== "PROVIDER_ERROR") return err;

  const details =
    err instanceof AppError && err.details && typeof err.details === "object"
      ? (err.details as Record<string, unknown>)
      : {};
  const upstream = asRecord(details.upstream);
  const body = asRecord(upstream.data ?? upstream);
  const fields = asRecord(body.fields ?? asRecord(body.error).fields);

  const reasons: string[] = [];
  for (const key of Object.keys(fields)) {
    const val = fields[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "string" && item.trim()) reasons.push(item.trim());
        else if (item && typeof item === "object") {
          const r = str(asRecord(item).reason) ?? str(asRecord(item).message);
          if (r) reasons.push(r);
        }
      }
    } else if (typeof val === "string" && val.trim()) {
      reasons.push(val.trim());
    }
  }

  const joined = reasons.join(" ").trim();
  if (/minimum|499|min\b/i.test(joined)) {
    return new AppError(
      `Minimum bank payout is ₦${MIN_BUSHA_BANK_RECEIVE_NGN} (plus fees). Try at least ₦610.`,
      400,
      "MIN_PAYOUT",
    );
  }
  if (joined) {
    // Keep payout field reasons readable; strip vendor brand only.
    return new AppError(sanitizePublicCopy(joined, joined), 400, "PAYOUT_REJECTED");
  }

  const msg = err instanceof Error ? err.message : "Bank payout failed";
  return new AppError(
    sanitizePublicCopy(msg, "Bank payout could not be started"),
    502,
    "PAYOUT_FAILED",
    targetAmount != null ? { targetAmount } : undefined,
  );
}

function extractBank(transfer: Record<string, unknown>): TempBankDetails {
  const payIn = asRecord(transfer.pay_in);
  const details = asRecord(payIn.recipient_details);
  return {
    accountName: scrubVendorBrand(str(details.account_name) ?? str(details.accountName)) ?? "Fulus",
    accountNumber: str(details.account_number) ?? str(details.accountNumber) ?? "",
    bankName: scrubVendorBrand(str(details.bank_name) ?? str(details.bankName)) ?? "Partner Bank",
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

  /**
   * Quote NGN bank payout from master float.
   * `targetAmount` = what the beneficiary bank account receives; Busha source includes fees.
   */
  async quoteMasterBankPayout(input: {
    targetAmount: number;
    accountName: string;
    accountNumber: string;
    bankName: string;
    bankCode: string;
    /** Reuse an existing master recipient id when quoting again. */
    recipientId?: string;
  }): Promise<MasterPayoutQuote> {
    const targetAmount = Number(input.targetAmount);
    if (!(targetAmount > 0)) throw new AppError("Invalid payout amount");
    if (targetAmount + 1e-9 < MIN_BUSHA_BANK_RECEIVE_NGN) {
      throw new AppError(
        `Minimum bank payout is ₦${MIN_BUSHA_BANK_RECEIVE_NGN} (plus fees). Try at least ₦610.`,
        400,
        "MIN_PAYOUT",
      );
    }

    if (!useBushaLive()) {
      const feeAmount = SIM_BANK_PAYOUT_FEE_NGN;
      const sourceAmount = +(targetAmount + feeAmount).toFixed(2);
      return {
        quoteId: simRef("QUO"),
        recipientId: input.recipientId || simRef("RCP"),
        sourceAmount,
        targetAmount,
        feeAmount,
        raw: { simulated: true },
        simulated: true,
      };
    }

    const recipientId =
      input.recipientId ||
      (await this.createMasterBankRecipient({
        accountName: input.accountName,
        accountNumber: input.accountNumber,
        bankName: input.bankName,
        bankCode: input.bankCode,
      }));

    let quoteRaw: Record<string, unknown>;
    try {
      quoteRaw = unwrapData(
        await bushaClient.createQuote(
          {
            source_currency: "NGN",
            target_currency: "NGN",
            target_amount: String(targetAmount),
            pay_in: { type: "balance" },
            pay_out: { type: "bank_transfer", recipient_id: recipientId },
          },
          null,
        ),
      );
    } catch (err) {
      throw mapBushaPayoutError(err, targetAmount);
    }

    const quoteId = str(quoteRaw.id);
    if (!quoteId) throw new AppError("Payout quote missing id", 502);

    const sourceAmount =
      num(quoteRaw.source_amount) ??
      num(asRecord(quoteRaw.source).amount) ??
      targetAmount + SIM_BANK_PAYOUT_FEE_NGN;
    const quotedTarget =
      num(quoteRaw.target_amount) ?? num(asRecord(quoteRaw.target).amount) ?? targetAmount;
    const feeAmount = extractQuoteFee(quoteRaw, sourceAmount, quotedTarget);

    return {
      quoteId,
      recipientId,
      sourceAmount: +sourceAmount.toFixed(2),
      targetAmount: +quotedTarget.toFixed(2),
      feeAmount: +feeAmount.toFixed(2),
      raw: quoteRaw,
      simulated: false,
    };
  }

  async executeQuotedPayout(quoteId: string): Promise<{ transferId: string; raw: Record<string, unknown> }> {
    if (!useBushaLive() || quoteId.startsWith("QUO_SIM")) {
      return { transferId: simRef("TRF"), raw: { simulated: true, quoteId } };
    }
    const transfer = unwrapData(await bushaClient.createTransfer({ quote_id: quoteId }, null));
    const transferId = str(transfer.id) ?? str(transfer.reference);
    if (!transferId) throw new AppError("Payout transfer missing id", 502);
    return { transferId, raw: transfer };
  }

  /**
   * Quote + create NGN→NGN bank payout from master float.
   * `amount` / `targetAmount` = what the recipient bank receives.
   */
  async payoutFromMaster(input: {
    amount?: number;
    targetAmount?: number;
    accountName: string;
    accountNumber: string;
    bankName: string;
    bankCode: string;
  }): Promise<MasterPayoutResult> {
    const targetAmount = Number(input.targetAmount ?? input.amount ?? 0);
    const quote = await this.quoteMasterBankPayout({
      targetAmount,
      accountName: input.accountName,
      accountNumber: input.accountNumber,
      bankName: input.bankName,
      bankCode: input.bankCode,
    });
    try {
      const { transferId, raw: transferRaw } = await this.executeQuotedPayout(quote.quoteId);
      return {
        ...quote,
        transferId,
        amount: quote.targetAmount,
        raw: { quote: quote.raw, transfer: transferRaw },
      };
    } catch (err) {
      throw mapBushaPayoutError(err, targetAmount);
    }
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
        quoteId: simRef("QUO"),
        amount,
        sourceAmount: amount,
        targetAmount: amount,
        feeAmount: 0,
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
        sourceAmount: amount,
        targetAmount: amount,
        feeAmount: 0,
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
