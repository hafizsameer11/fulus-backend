import { prisma } from "./prisma.js";
import { sanitizePublicCopy } from "./errors.js";

export async function createInboxMessage(params: {
  userId: string;
  title: string;
  body: string;
  category?: string;
}) {
  return prisma.inboxMessage.create({
    data: {
      userId: params.userId,
      title: sanitizePublicCopy(params.title, "Notification"),
      body: sanitizePublicCopy(params.body, "Open the app for details."),
      category: params.category ?? "general",
      read: false,
    },
  });
}
