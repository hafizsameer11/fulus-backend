import { prisma } from "../prisma.js";

export async function createInboxMessage(params: {
  userId: string;
  title: string;
  body: string;
  category?: string;
}) {
  return prisma.inboxMessage.create({
    data: {
      userId: params.userId,
      title: params.title,
      body: params.body,
      category: params.category ?? "general",
      read: false,
    },
  });
}
