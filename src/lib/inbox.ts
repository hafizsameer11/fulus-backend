import { prisma } from "./prisma.js";
import { sanitizePublicCopy } from "./errors.js";
import { maybeSendPush } from "./push.js";

export async function createInboxMessage(params: {
  userId: string;
  title: string;
  body: string;
  category?: string;
  /** Skip Expo push (inbox only). */
  skipPush?: boolean;
  data?: Record<string, unknown>;
}) {
  const title = sanitizePublicCopy(params.title, "Notification");
  const body = sanitizePublicCopy(params.body, "Open the app for details.");
  const category = params.category ?? "general";

  const row = await prisma.inboxMessage.create({
    data: {
      userId: params.userId,
      title,
      body,
      category,
      read: false,
    },
  });

  if (!params.skipPush) {
    void maybeSendPush({
      userId: params.userId,
      title,
      body,
      category,
      data: { inboxId: row.id, ...(params.data ?? {}) },
    });
  }

  return row;
}
