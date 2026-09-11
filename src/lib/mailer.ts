import nodemailer from "nodemailer";
import { env } from "../config/env.js";
import { AppError } from "./errors.js";

type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export function emailConfigured() {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
}

function createTransport() {
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    },
  });
}

/**
 * Sends transactional email via custom SMTP (e.g. Hostinger).
 * Without SMTP credentials: logs in non-production; throws in production.
 */
export async function sendEmail(input: SendEmailInput) {
  if (!emailConfigured()) {
    if (env.NODE_ENV === "production") {
      throw new AppError("Email delivery is not configured", 503, "EMAIL_NOT_CONFIGURED");
    }
    console.info(`[mailer:dev] to=${input.to} subject=${input.subject}\n${input.text}`);
    return { id: "dev-mail", simulated: true as const };
  }

  try {
    const transport = createTransport();
    const info = await transport.sendMail({
      from: env.EMAIL_FROM,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });
    return { id: info.messageId || "sent", simulated: false as const };
  } catch (err) {
    console.error("[mailer] SMTP error", err);
    throw new AppError(
      err instanceof Error ? err.message : "Failed to send email",
      502,
      "EMAIL_SEND_FAILED",
    );
  }
}

export function otpEmailContent(code: string, purpose: "SIGNUP" | "RESET") {
  const action = purpose === "SIGNUP" ? "verify your Fulus email" : "reset your Fulus password";
  const subject = purpose === "SIGNUP" ? "Your Fulus verification code" : "Your Fulus password reset code";
  const text = `Your code to ${action} is ${code}. It expires in 10 minutes. If you did not request this, ignore this email.`;
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0A0A0A">
      <div style="font-size:20px;font-weight:700;margin-bottom:8px">Fulus</div>
      <p style="margin:0 0 16px;color:#444">Use this code to ${action}:</p>
      <div style="font-size:32px;font-weight:700;letter-spacing:8px;background:#FFFBEA;border-radius:12px;padding:16px 20px;text-align:center">${code}</div>
      <p style="margin:16px 0 0;font-size:13px;color:#666">Expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
    </div>
  `;
  return { subject, html, text };
}
