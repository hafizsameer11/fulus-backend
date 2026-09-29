import type { Request, Response } from "express";
import type { Prisma } from "@prisma/client";
import { ok } from "../../../lib/http.js";
import { NotFoundError } from "../../../lib/errors.js";
import { prisma } from "../../../lib/prisma.js";
import { parsePagination } from "../lib/pagination.js";

function userDisplayName(user: { firstName: string | null; lastName: string | null; email: string }) {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name || user.email;
}

export class AdminListController {
  listUsers = async (req: Request, res: Response) => {
    const { page, limit, skip } = parsePagination(req);
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const where: Prisma.UserWhereInput = search
      ? {
          OR: [
            { email: { contains: search } },
            { phone: { contains: search } },
            { firstName: { contains: search } },
            { lastName: { contains: search } },
          ],
        }
      : {};

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          kycTier: true,
          kycStatus: true,
          status: true,
          createdAt: true,
        },
      }),
    ]);

    return ok(res, {
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        name: userDisplayName(u),
        phone: u.phone,
        kycTier: u.kycTier,
        kycStatus: u.kycStatus,
        status: u.status,
        createdAt: u.createdAt,
      })),
      page,
      limit,
      total,
    });
  };

  getUser = async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        kycTier: true,
        kycStatus: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        wallets: {
          select: {
            id: true,
            currency: true,
            isVirtual: true,
            available: true,
            pending: true,
            updatedAt: true,
          },
        },
        kycChecks: { orderBy: { createdAt: "desc" }, take: 50 },
        _count: { select: { cards: true } },
      },
    });
    if (!user) throw new NotFoundError("User not found");

    const transactions = await prisma.transaction.findMany({
      where: { userId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        type: true,
        status: true,
        amount: true,
        fee: true,
        currency: true,
        reference: true,
        description: true,
        createdAt: true,
      },
    });

    const { wallets, kycChecks, _count, ...profile } = user;
    return ok(res, {
      user: {
        ...profile,
        name: userDisplayName(user),
        cardsCount: _count.cards,
      },
      wallets: wallets.map((w) => ({
        ...w,
        available: Number(w.available),
        pending: Number(w.pending),
      })),
      transactions: transactions.map((t) => ({
        ...t,
        amount: Number(t.amount),
        fee: Number(t.fee),
      })),
      kycChecks,
    });
  };

  listTransactions = async (req: Request, res: Response) => {
    const { page, limit, skip } = parsePagination(req);
    const userId = typeof req.query.userId === "string" ? req.query.userId : undefined;
    const where: Prisma.TransactionWhereInput = userId ? { userId } : {};

    const [total, items] = await Promise.all([
      prisma.transaction.count({ where }),
      prisma.transaction.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        select: {
          id: true,
          userId: true,
          type: true,
          status: true,
          amount: true,
          fee: true,
          currency: true,
          reference: true,
          description: true,
          provider: true,
          createdAt: true,
          user: { select: { email: true } },
        },
      }),
    ]);

    return ok(res, {
      transactions: items.map(({ user, ...t }) => ({
        ...t,
        amount: Number(t.amount),
        fee: Number(t.fee),
        userEmail: user.email,
      })),
      page,
      limit,
      total,
    });
  };

  getTransaction = async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const tx = await prisma.transaction.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
        ledgerEntries: {
          orderBy: { createdAt: "asc" },
          include: { wallet: { select: { currency: true, userId: true } } },
        },
      },
    });
    if (!tx) throw new NotFoundError("Transaction not found");

    const { user, ledgerEntries, ...rest } = tx;
    return ok(res, {
      transaction: {
        ...rest,
        amount: Number(rest.amount),
        fee: Number(rest.fee),
        userEmail: user.email,
        userName: userDisplayName(user),
        userId: user.id,
      },
      ledgerEntries: ledgerEntries.map((e) => ({
        id: e.id,
        walletId: e.walletId,
        currency: e.wallet.currency,
        type: e.type,
        amount: Number(e.amount),
        balanceAfter: Number(e.balanceAfter),
        description: e.description,
        createdAt: e.createdAt,
      })),
    });
  };

  listDeposits = async (req: Request, res: Response) => {
    const { page, limit, skip } = parsePagination(req);
    const [total, deposits] = await Promise.all([
      prisma.deposit.count(),
      prisma.deposit.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          user: { select: { id: true, email: true, firstName: true, lastName: true } },
        },
      }),
    ]);

    return ok(res, {
      deposits: deposits.map(({ user, ...d }) => ({
        id: d.id,
        userId: d.userId,
        userEmail: user.email,
        userName: userDisplayName(user),
        method: d.method,
        currency: d.currency,
        amount: d.amount != null ? Number(d.amount) : null,
        status: d.status,
        provider: d.provider,
        providerRef: d.providerRef,
        transactionId: d.transactionId,
        confirmedAt: d.confirmedAt,
        createdAt: d.createdAt,
      })),
      page,
      limit,
      total,
    });
  };

  listPayouts = async (req: Request, res: Response) => {
    const { page, limit, skip } = parsePagination(req);
    const [total, payouts] = await Promise.all([
      prisma.bankTransfer.count(),
      prisma.bankTransfer.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          user: { select: { id: true, email: true, firstName: true, lastName: true } },
        },
      }),
    ]);

    return ok(res, {
      payouts: payouts.map(({ user, ...p }) => ({
        id: p.id,
        userId: p.userId,
        userEmail: user.email,
        userName: userDisplayName(user),
        transactionId: p.transactionId,
        currency: p.currency,
        amount: Number(p.amount),
        fee: Number(p.fee),
        accountName: p.accountName,
        accountNumber: p.accountNumber,
        bankCode: p.bankCode,
        bankName: p.bankName,
        status: p.status,
        provider: p.provider,
        providerRef: p.providerRef,
        failureReason: p.failureReason,
        createdAt: p.createdAt,
      })),
      page,
      limit,
      total,
    });
  };

  listCards = async (req: Request, res: Response) => {
    const { page, limit, skip } = parsePagination(req);
    const userId = typeof req.query.userId === "string" ? req.query.userId : undefined;
    const where = userId ? { userId } : {};
    const [total, cards] = await Promise.all([
      prisma.card.count({ where }),
      prisma.card.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          user: { select: { id: true, email: true, firstName: true, lastName: true } },
        },
      }),
    ]);

    return ok(res, {
      cards: cards.map(({ user, ...c }) => ({
        id: c.id,
        userId: c.userId,
        userEmail: user.email,
        userName: userDisplayName(user),
        brand: c.brand,
        last4: c.last4,
        currency: c.currency,
        status: c.status,
        label: c.label,
        balance: Number(c.balance),
        createdAt: c.createdAt,
      })),
      page,
      limit,
      total,
    });
  };
}

export const adminListController = new AdminListController();
