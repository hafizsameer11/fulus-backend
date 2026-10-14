import { prisma } from "./prisma.js";
import { env } from "../config/env.js";

export type PushPrefKey =
  | "txPush"
  | "login"
  | "security"
  | "rates"
  | "promo"
  | "product";

type NotifPrefs = Partial<Record<PushPrefKey | "txEmail" | "txSms", boolean>>;

/** Map inbox / event category → preference toggle. */
const CATEGORY_TO_PREF: Record<string, PushPrefKey> = {
  tx: "txPush",
  transaction: "txPush",
  bill: "txPush",
  bills: "txPush",
  card: "txPush",
  cards: "txPush",
  deposit: "txPush",
  transfer: "txPush",
  wallet: "txPush",
  crypto: "txPush",
  esim: "txPush",
  login: "login",
  security: "security",
  kyc: "security",
  rates: "rates",
  promo: "promo",
  product: "product",
  general: "product",
};

const DEFAULT_PREFS: Record<PushPrefKey, boolean> = {
  txPush: true,
  login: true,
  security: true,
  rates: false,
  promo: false,
  product: true,
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function prefAllows(prefs: NotifPrefs, category: string): boolean {
  const key = CATEGORY_TO_PREF[category.toLowerCase()] ?? "product";
  const value = prefs[key];
  if (typeof value === "boolean") return value;
  return DEFAULT_PREFS[key] ?? true;
}

function isExpoPushToken(token: string): boolean {
  return /^ExponentPushToken\[.+\]$/.test(token) || /^ExpoPushToken\[.+\]$/.test(token);
}

/**
 * Send Expo push notifications to a user when their prefs allow it.
 * Fire-and-forget safe — never throws to callers.
 */
export async function maybeSendPush(params: {
  userId: string;
  title: string;
  body: string;
  category?: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: params.userId },
      select: { flagsJson: true },
    });
    if (!user) return;

    const flags = asRecord(user.flagsJson);
    const prefs = asRecord(flags.notifPrefs) as NotifPrefs;
    const category = params.category ?? "general";
    if (!prefAllows(prefs, category)) return;

    const tokens = (Array.isArray(flags.pushTokens) ? flags.pushTokens : [])
      .filter((t): t is string => typeof t === "string" && isExpoPushToken(t));
    if (!tokens.length) return;

    const messages = tokens.map((to) => ({
      to,
      sound: "default" as const,
      title: params.title,
      body: params.body,
      data: {
        category,
        ...(params.data ?? {}),
      },
      channelId: category === "security" || category === "login" ? "security" : "default",
      priority: "high" as const,
    }));

    const headers: Record<string, string> = {
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate",
      "Content-Type": "application/json",
    };
    if (env.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${env.EXPO_ACCESS_TOKEN}`;

    // Expo accepts up to 100 messages per request.
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100);
      const res = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers,
        body: JSON.stringify(chunk),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error("[push] Expo send failed", res.status, text.slice(0, 300));
      }
    }
  } catch (err) {
    console.error("[push] failed", err);
  }
}
