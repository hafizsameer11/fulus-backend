import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  APP_URL: z.string().url().default("http://localhost:4000"),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default("7d"),
  /** Shared machine key for scripts; never use the default in production. */
  ADMIN_API_KEY: z.string().optional().default("fulus-admin-dev-key"),
  /** Bootstrap staff login (email/password). No Google/TOTP 2FA. */
  ADMIN_STAFF_EMAIL: z.string().optional().default(""),
  ADMIN_STAFF_PASSWORD: z.string().optional().default(""),
  ADMIN_STAFF_NAME: z.string().optional().default("Fulus Admin"),

  PAGOCARDS_BASE_URL: z.string().url().default("https://pagocards.com"),
  PAGOCARDS_PUBLIC_KEY: z.string().optional().default(""),
  PAGOCARDS_SECRET_KEY: z.string().optional().default(""),

  BUSHA_BASE_URL: z.string().url().default("https://api.sandbox.busha.so"),
  BUSHA_SECRET_KEY: z.string().optional().default(""),
  BUSHA_PUBLIC_KEY: z.string().optional().default(""),
  BUSHA_PROFILE_ID: z.string().optional().default(""),
  BUSHA_WEBHOOK_SECRET: z.string().optional().default(""),

  PREMBLY_BASE_URL: z.string().url().default("https://api.prembly.com"),
  PREMBLY_API_KEY: z.string().optional().default(""),
  PREMBLY_APP_ID: z.string().optional().default(""),

  STROWALLET_BASE_URL: z.string().url().default("https://strowallet.com"),
  STROWALLET_PUBLIC_KEY: z.string().optional().default(""),
  STROWALLET_SECRET_KEY: z.string().optional().default(""),

  ESIM_GO_BASE_URL: z.string().url().default("https://api.esim-go.com/v2.5"),
  ESIM_GO_API_KEY: z.string().optional().default(""),

  /** Flutterwave — app public key (EXPO); API verifies with secret (must match TEST or LIVE). */
  FLUTTERWAVE_BASE_URL: z.string().url().default("https://api.flutterwave.com"),
  /** Primary secret. Use FLWSECK_TEST-… while the app uses FLWPUBK_TEST-…. */
  FLUTTERWAVE_SECRET_KEY: z.string().optional().default(""),
  /** Optional sandbox secret tried if primary (live) cannot verify a test charge. */
  FLUTTERWAVE_TEST_SECRET_KEY: z.string().optional().default(""),
  FLUTTERWAVE_PUBLIC_KEY: z.string().optional().default(""),
  FLUTTERWAVE_WEBHOOK_SECRET: z.string().optional().default(""),
  FLUTTERWAVE_REDIRECT_URL: z.string().optional().default(""),
  /**
   * When true (default): credit wallet from app checkout success without calling Flutterwave verify.
   * Set to "0" later to require server-side Flutterwave verification again.
   */
  FLUTTERWAVE_TRUST_CLIENT_SUCCESS: z
    .string()
    .optional()
    .default("1")
    .transform((v) => v !== "0" && v.toLowerCase() !== "false"),

  /** Custom SMTP (Hostinger, etc.) — required in production for OTP / reset emails */
  SMTP_HOST: z.string().optional().default(""),
  SMTP_PORT: z.coerce.number().default(465),
  SMTP_SECURE: z
    .string()
    .optional()
    .default("true")
    .transform((v) => v !== "0" && v.toLowerCase() !== "false"),
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASS: z.string().optional().default(""),
  EMAIL_FROM: z.string().default("Fulus <noreply@fulusapp.co>"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration");
}

export const env = parsed.data;

if (env.NODE_ENV === "production" && env.ADMIN_API_KEY === "fulus-admin-dev-key") {
  throw new Error(
    "ADMIN_API_KEY must be set to a strong unique secret in production (default fulus-admin-dev-key is forbidden)",
  );
}
