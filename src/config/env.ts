import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  APP_URL: z.string().url().default("http://localhost:4000"),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default("7d"),
  ADMIN_API_KEY: z.string().optional().default("fulus-admin-dev-key"),

  PAGOCARDS_BASE_URL: z.string().url().default("https://pagocards.com"),
  PAGOCARDS_PUBLIC_KEY: z.string().optional().default(""),
  PAGOCARDS_SECRET_KEY: z.string().optional().default(""),

  BUSHA_BASE_URL: z.string().url().default("https://api.sandbox.busha.so"),
  BUSHA_SECRET_KEY: z.string().optional().default(""),
  BUSHA_PUBLIC_KEY: z.string().optional().default(""),
  BUSHA_PROFILE_ID: z.string().optional().default(""),

  PREMBLY_BASE_URL: z.string().url().default("https://api.prembly.com"),
  PREMBLY_API_KEY: z.string().optional().default(""),
  PREMBLY_APP_ID: z.string().optional().default(""),

  STROWALLET_BASE_URL: z.string().url().default("https://strowallet.com"),
  STROWALLET_PUBLIC_KEY: z.string().optional().default(""),
  STROWALLET_SECRET_KEY: z.string().optional().default(""),

  ESIM_GO_BASE_URL: z.string().url().default("https://api.esim-go.com/v2.5"),
  ESIM_GO_API_KEY: z.string().optional().default(""),

  /** Resend API key — required in production for OTP / reset emails */
  RESEND_API_KEY: z.string().optional().default(""),
  EMAIL_FROM: z.string().default("Fulus <onboarding@resend.dev>"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration");
}

export const env = parsed.data;
