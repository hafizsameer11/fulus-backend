import { z } from "zod";
import { prisma } from "../../../lib/prisma.js";
import { AppError, NotFoundError } from "../../../lib/errors.js";

export const createTicketSchema = z.object({
  topic: z.string().min(1).max(64),
  message: z.string().min(1).max(4000),
});

export const postMessageSchema = z.object({
  body: z.string().min(1).max(4000),
});

export const adminReplySchema = z.object({
  body: z.string().min(1).max(4000),
});

const TOPIC_REPLIES: Record<string, string> = {
  transfers: "Thanks — I can help with a transfer. Please share the reference number and the amount you sent.",
  cards: "Got it. Which card is affected (last 4 digits), and what did the decline message say?",
  crypto: "Sure. Please send the asset, network and the transaction hash so I can trace it.",
  kyc: "Happy to check that. Which tier are you applying for, and when did you submit your documents?",
  bills: "No problem. Which bill or eSIM plan is it, and what time did you make the purchase?",
  account: "Let's secure your account first. Can you confirm the email address on the account?",
  other: "I'm listening — please describe the issue in as much detail as you can.",
};

function autoReply(topic: string): string {
  return TOPIC_REPLIES[topic] ?? TOPIC_REPLIES.other ?? "Thanks — we'll be with you shortly.";
}

export class SupportService {
  async createTicket(userId: string, input: z.infer<typeof createTicketSchema>) {
    const ticket = await prisma.supportTicket.create({
      data: {
        userId,
        topic: input.topic,
        messages: {
          create: [
            { senderRole: "USER", body: input.message },
            { senderRole: "BOT", body: autoReply(input.topic) },
          ],
        },
      },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    return ticket;
  }

  async listTickets(userId: string) {
    return prisma.supportTicket.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take: 20,
      include: {
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
  }

  async getTicket(userId: string, ticketId: string) {
    const ticket = await prisma.supportTicket.findFirst({
      where: { id: ticketId, userId },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!ticket) throw new NotFoundError("Ticket not found");
    return ticket;
  }

  async postMessage(userId: string, ticketId: string, input: z.infer<typeof postMessageSchema>) {
    const ticket = await prisma.supportTicket.findFirst({ where: { id: ticketId, userId } });
    if (!ticket) throw new NotFoundError("Ticket not found");
    if (ticket.status === "CLOSED") throw new AppError("Ticket is closed", 400, "TICKET_CLOSED");

    const userMsg = await prisma.supportMessage.create({
      data: { ticketId, senderRole: "USER", body: input.body },
    });

    await prisma.supportTicket.update({ where: { id: ticketId }, data: { updatedAt: new Date() } });

    return { message: userMsg };
  }

  async adminListTickets(status?: string) {
    const where =
      status && ["OPEN", "CLOSED"].includes(status) ? { status: status as "OPEN" | "CLOSED" } : {};
    return prisma.supportTicket.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: 100,
      include: {
        user: { select: { id: true, email: true, firstName: true, lastName: true, phone: true } },
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
  }

  async adminGetTicket(ticketId: string) {
    const ticket = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: {
        user: { select: { id: true, email: true, firstName: true, lastName: true, phone: true } },
        messages: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!ticket) throw new NotFoundError("Ticket not found");
    return ticket;
  }

  async adminReply(ticketId: string, input: z.infer<typeof adminReplySchema>, staffEmail: string) {
    const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundError("Ticket not found");
    if (ticket.status === "CLOSED") throw new AppError("Ticket is closed", 400, "TICKET_CLOSED");

    const message = await prisma.supportMessage.create({
      data: {
        ticketId,
        senderRole: "STAFF",
        body: `[${staffEmail}] ${input.body}`,
      },
    });
    await prisma.supportTicket.update({ where: { id: ticketId }, data: { updatedAt: new Date() } });
    return { message };
  }
}

export const supportService = new SupportService();
