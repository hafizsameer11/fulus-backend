import { prisma } from "./prisma.js";
import { emailConfigured, sendEmail } from "./mailer.js";

type ReceiptInput = {
  userId: string;
  type: string;
  amount: string | number;
  currency: string;
  description?: string | null;
  reference?: string | null;
};

type EducationPinInput = {
  userId: string;
  pin: string;
  productName?: string | null;
  candidateName?: string | null;
  amount: string | number;
  reference?: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Fire-and-forget email receipt when the user has txEmail enabled. */
export async function maybeSendTxReceiptEmail(input: ReceiptInput): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { email: true, flagsJson: true },
    });
    if (!user?.email) return;
    const flags = asRecord(user.flagsJson);
    const prefs = asRecord(flags.notifPrefs);
    // Default on when unset (matches mobile defaults).
    if (prefs.txEmail === false) return;

    const amount = Number(input.amount);
    const amtStr = Number.isFinite(amount)
      ? amount.toLocaleString(undefined, { maximumFractionDigits: 8 })
      : String(input.amount);
    const subject = `Fulus receipt · ${input.type.replace(/_/g, " ")}`;
    const text = [
      `Your ${input.type.replace(/_/g, " ").toLowerCase()} of ${input.currency} ${amtStr} was recorded.`,
      input.description ? `Details: ${input.description}` : null,
      input.reference ? `Reference: ${input.reference}` : null,
      "",
      "Open the Fulus app to view the full receipt.",
    ]
      .filter(Boolean)
      .join("\n");
    const html = `
      <div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0A0A0A">
        <div style="font-size:20px;font-weight:700;margin-bottom:8px">Fulus</div>
        <p style="margin:0 0 12px;color:#444">Transaction receipt</p>
        <div style="background:#FFFBEA;border-radius:12px;padding:16px 20px">
          <div style="font-size:13px;color:#666">${input.type.replace(/_/g, " ")}</div>
          <div style="font-size:28px;font-weight:700;margin-top:4px">${input.currency} ${amtStr}</div>
          ${input.description ? `<div style="margin-top:8px;font-size:13px;color:#444">${input.description}</div>` : ""}
          ${input.reference ? `<div style="margin-top:4px;font-size:12px;color:#888">Ref ${input.reference}</div>` : ""}
        </div>
      </div>
    `;

    if (!emailConfigured() && process.env.NODE_ENV === "production") return;
    await sendEmail({ to: user.email, subject, html, text });
  } catch (err) {
    console.error("[tx-receipt-email] failed", err);
  }
}

/** Always email education PINs to the account holder (delivery is not optional). */
export async function maybeSendEducationPinEmail(input: EducationPinInput): Promise<void> {
  try {
    const pin = input.pin.trim();
    if (!pin) return;

    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { email: true },
    });
    if (!user?.email) return;

    const amount = Number(input.amount);
    const amtStr = Number.isFinite(amount)
      ? `₦${amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
      : String(input.amount);
    const product = input.productName?.trim() || "Education PIN";
    const candidate = input.candidateName?.trim();
    const subject = `Your ${product} · Fulus`;
    const text = [
      `Your ${product} is ready.`,
      candidate ? `Candidate: ${candidate}` : null,
      `Amount: ${amtStr}`,
      `PIN: ${pin}`,
      input.reference ? `Reference: ${input.reference}` : null,
      "",
      "Keep this PIN private. You can also copy it from the Fulus app receipt.",
    ]
      .filter(Boolean)
      .join("\n");
    const html = `
      <div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0A0A0A">
        <div style="font-size:20px;font-weight:700;margin-bottom:8px">Fulus</div>
        <p style="margin:0 0 12px;color:#444">${product} ready</p>
        <div style="background:#FFFBEA;border-radius:12px;padding:16px 20px">
          ${candidate ? `<div style="font-size:13px;color:#666">Candidate · ${candidate}</div>` : ""}
          <div style="font-size:13px;color:#666;margin-top:4px">${amtStr}</div>
          <div style="font-size:12px;color:#666;margin-top:12px;text-transform:uppercase;letter-spacing:0.08em">PIN</div>
          <div style="font-size:26px;font-weight:700;letter-spacing:2px;margin-top:4px">${pin}</div>
          ${input.reference ? `<div style="margin-top:10px;font-size:12px;color:#888">Ref ${input.reference}</div>` : ""}
        </div>
        <p style="margin:16px 0 0;font-size:12px;color:#666">Keep this PIN private. You can also open the receipt in the Fulus app.</p>
      </div>
    `;

    if (!emailConfigured() && process.env.NODE_ENV === "production") {
      console.error("[education-pin-email] Resend not configured — PIN not emailed");
      return;
    }
    await sendEmail({ to: user.email, subject, html, text });
  } catch (err) {
    console.error("[education-pin-email] failed", err);
  }
}
