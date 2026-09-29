import type { Request, Response } from "express";
import { ok } from "../../../lib/http.js";
import { AppError, NotFoundError } from "../../../lib/errors.js";
import { prisma } from "../../../lib/prisma.js";
import { parsePagination } from "../lib/pagination.js";

function userDisplayName(user: { firstName: string | null; lastName: string | null; email: string }) {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name || user.email;
}

export class AdminOpsController {
  overview = async (_req: Request, res: Response) => {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [
      usersTotal,
      users24h,
      kycPending,
      openTickets,
      cardsActive,
      tx24h,
      depositsPending,
      payoutsPending,
      walletsAgg,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: since24h } } }),
      prisma.kycCheck.count({ where: { status: "PENDING" } }),
      prisma.supportTicket.count({ where: { status: "OPEN" } }),
      prisma.card.count({ where: { status: { in: ["ACTIVE", "FROZEN"] } } }),
      prisma.transaction.count({ where: { createdAt: { gte: since24h } } }),
      prisma.deposit.count({ where: { status: "PENDING" } }),
      prisma.bankTransfer.count({ where: { status: "PENDING" } }),
      prisma.wallet.groupBy({
        by: ["currency"],
        _sum: { available: true },
        where: { isVirtual: false },
      }),
    ]);

    return ok(res, {
      at: new Date().toISOString(),
      usersTotal,
      users24h,
      kycPending,
      openTickets,
      cardsActive,
      tx24h,
      depositsPending,
      payoutsPending,
      walletBalances: walletsAgg.map((w) => ({
        currency: w.currency,
        available: Number(w._sum.available ?? 0),
      })),
    });
  };

  listSwaps = async (req: Request, res: Response) => {
    const { page, limit, skip } = parsePagination(req);
    const [total, items] = await Promise.all([
      prisma.swap.count(),
      prisma.swap.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
      }),
    ]);
    return ok(res, {
      swaps: items.map(({ user, ...s }) => ({
        id: s.id,
        userId: s.userId,
        userEmail: user.email,
        userName: userDisplayName(user),
        transactionId: s.transactionId,
        fromCurrency: s.fromCurrency,
        toCurrency: s.toCurrency,
        fromAmount: Number(s.fromAmount),
        toAmount: Number(s.toAmount),
        rateApplied: Number(s.rateApplied),
        midRate: Number(s.midRate),
        spreadBps: s.spreadBps,
        status: s.status,
        createdAt: s.createdAt,
      })),
      page,
      limit,
      total,
    });
  };

  listLedger = async (req: Request, res: Response) => {
    const { page, limit, skip } = parsePagination(req);
    const [total, items] = await Promise.all([
      prisma.ledgerEntry.count(),
      prisma.ledgerEntry.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          wallet: {
            select: {
              currency: true,
              userId: true,
              user: { select: { email: true, firstName: true, lastName: true } },
            },
          },
          transaction: { select: { id: true, type: true, reference: true } },
        },
      }),
    ]);
    return ok(res, {
      entries: items.map((e) => ({
        id: e.id,
        walletId: e.walletId,
        userId: e.wallet.userId,
        userEmail: e.wallet.user.email,
        userName: userDisplayName(e.wallet.user),
        currency: e.wallet.currency,
        type: e.type,
        amount: Number(e.amount),
        balanceAfter: Number(e.balanceAfter),
        description: e.description,
        transactionId: e.transactionId,
        transactionType: e.transaction?.type ?? null,
        reference: e.transaction?.reference ?? null,
        createdAt: e.createdAt,
      })),
      page,
      limit,
      total,
    });
  };

  listBeneficiaries = async (req: Request, res: Response) => {
    const { page, limit, skip } = parsePagination(req);
    const [total, items] = await Promise.all([
      prisma.beneficiary.count(),
      prisma.beneficiary.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
      }),
    ]);
    return ok(res, {
      beneficiaries: items.map(({ user, ...b }) => ({
        ...b,
        userEmail: user.email,
        userName: userDisplayName(user),
      })),
      page,
      limit,
      total,
    });
  };

  listVirtualAccounts = async (req: Request, res: Response) => {
    const { page, limit, skip } = parsePagination(req);
    const [total, items] = await Promise.all([
      prisma.virtualAccount.count(),
      prisma.virtualAccount.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
      }),
    ]);
    return ok(res, {
      accounts: items.map(({ user, ...a }) => ({
        ...a,
        userEmail: user.email,
        userName: userDisplayName(user),
      })),
      page,
      limit,
      total,
    });
  };

  listBillServices = async (_req: Request, res: Response) => {
    const services = await prisma.billService.findMany({
      orderBy: [{ category: "asc" }, { name: "asc" }],
      include: {
        variations: { orderBy: { name: "asc" } },
        _count: { select: { variations: true } },
      },
    });
    return ok(res, {
      services: services.map(({ _count, variations, isActive, ...s }) => ({
        ...s,
        active: isActive,
        variationsCount: _count.variations,
        variations: variations.map((v) => ({
          id: v.id,
          code: v.code,
          name: v.name,
          amount: v.amount != null ? Number(v.amount) : null,
          isActive: v.isActive,
        })),
      })),
    });
  };

  listBillProducts = async (_req: Request, res: Response) => {
    const variations = await prisma.billVariation.findMany({
      orderBy: [{ serviceId: "asc" }, { name: "asc" }],
      include: { service: { select: { id: true, name: true, category: true, provider: true, isActive: true } } },
    });
    return ok(res, {
      products: variations.map(({ service, ...v }) => ({
        id: v.id,
        code: v.code,
        name: v.name,
        amount: v.amount != null ? Number(v.amount) : null,
        isActive: v.isActive,
        serviceId: service.id,
        serviceName: service.name,
        category: service.category,
        provider: service.provider,
        serviceActive: service.isActive,
        createdAt: v.createdAt,
      })),
    });
  };

  getBillPayment = async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const payment = await prisma.billPayment.findUnique({
      where: { id },
      include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
    });
    if (!payment) throw new NotFoundError("Bill payment not found");
    const service = await prisma.billService.findUnique({ where: { id: payment.serviceId } });
    const { user, ...p } = payment;
    return ok(res, {
      payment: {
        id: p.id,
        userId: p.userId,
        userEmail: user.email,
        userName: userDisplayName(user),
        serviceId: p.serviceId,
        serviceName: service?.name ?? null,
        category: p.category,
        provider: p.provider,
        customerRef: p.customerRef,
        variationCode: p.variationCode,
        amount: Number(p.amount),
        phone: p.phone,
        status: p.status,
        providerRef: p.providerRef,
        token: p.token,
        providerPayload: p.providerPayload,
        transactionId: p.transactionId,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      },
    });
  };

  getCryptoOrder = async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const order = await prisma.cryptoOrder.findUnique({
      where: { id },
      include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
    });
    if (!order) throw new NotFoundError("Crypto order not found");
    const { user, ...o } = order;
    return ok(res, {
      order: {
        id: o.id,
        userId: o.userId,
        userEmail: user.email,
        userName: userDisplayName(user),
        side: o.side,
        baseCurrency: o.baseCurrency,
        quoteCurrency: o.quoteCurrency,
        amount: Number(o.amount),
        quoteAmount: o.quoteAmount != null ? Number(o.quoteAmount) : null,
        rate: o.rate != null ? Number(o.rate) : null,
        network: o.network,
        status: o.status,
        provider: o.provider,
        providerRef: o.providerRef,
        transactionId: o.transactionId,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
      },
    });
  };

  listBillPayments = async (req: Request, res: Response) => {
    const { page, limit, skip } = parsePagination(req);
    const [total, items] = await Promise.all([
      prisma.billPayment.count(),
      prisma.billPayment.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          user: { select: { id: true, email: true, firstName: true, lastName: true } },
        },
      }),
    ]);
    const serviceIds = [...new Set(items.map((p) => p.serviceId))];
    const services = serviceIds.length
      ? await prisma.billService.findMany({ where: { id: { in: serviceIds } } })
      : [];
    const byId = new Map(services.map((s) => [s.id, s]));
    return ok(res, {
      payments: items.map(({ user, ...p }) => {
        const service = byId.get(p.serviceId);
        return {
          id: p.id,
          userId: p.userId,
          userEmail: user.email,
          userName: userDisplayName(user),
          serviceId: p.serviceId,
          serviceName: service?.name ?? null,
          category: p.category,
          provider: p.provider || "strowallet",
          customerRef: p.customerRef,
          variationCode: p.variationCode,
          amount: Number(p.amount),
          status: p.status,
          providerRef: p.providerRef,
          transactionId: p.transactionId,
          token: p.token,
          phone: p.phone,
          createdAt: p.createdAt,
        };
      }),
      page,
      limit,
      total,
    });
  };

  listCryptoOrders = async (req: Request, res: Response) => {
    const { page, limit, skip } = parsePagination(req);
    const [total, items] = await Promise.all([
      prisma.cryptoOrder.count(),
      prisma.cryptoOrder.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
      }),
    ]);
    return ok(res, {
      orders: items.map(({ user, ...o }) => ({
        id: o.id,
        userId: o.userId,
        userEmail: user.email,
        userName: userDisplayName(user),
        side: o.side,
        baseCurrency: o.baseCurrency,
        quoteCurrency: o.quoteCurrency,
        amount: Number(o.amount),
        quoteAmount: o.quoteAmount != null ? Number(o.quoteAmount) : null,
        rate: o.rate != null ? Number(o.rate) : null,
        network: o.network,
        status: o.status,
        provider: o.provider,
        providerRef: o.providerRef,
        transactionId: o.transactionId,
        createdAt: o.createdAt,
      })),
      page,
      limit,
      total,
    });
  };

  listCryptoAddresses = async (req: Request, res: Response) => {
    const { page, limit, skip } = parsePagination(req);
    const [total, items] = await Promise.all([
      prisma.cryptoAddress.count(),
      prisma.cryptoAddress.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
      }),
    ]);
    return ok(res, {
      addresses: items.map(({ user, ...a }) => ({
        ...a,
        userEmail: user.email,
        userName: userDisplayName(user),
      })),
      page,
      limit,
      total,
    });
  };

  listCryptoWallets = async (_req: Request, res: Response) => {
    const rows = await prisma.wallet.groupBy({
      by: ["currency"],
      where: { currency: { in: ["BTC", "ETH", "USDT"] }, isVirtual: false },
      _sum: { available: true, pending: true },
      _count: true,
    });
    return ok(res, {
      wallets: rows.map((r) => ({
        currency: r.currency,
        available: Number(r._sum?.available ?? 0),
        pending: Number(r._sum?.pending ?? 0),
        holders: r._count,
      })),
    });
  };

  listEsims = async (req: Request, res: Response) => {
    const { page, limit, skip } = parsePagination(req);
    const [total, items] = await Promise.all([
      prisma.esim.count(),
      prisma.esim.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
      }),
    ]);
    return ok(res, {
      esims: items.map(({ user, ...e }) => ({
        id: e.id,
        userId: e.userId,
        userEmail: user.email,
        userName: userDisplayName(user),
        label: e.label,
        status: e.status,
        iccid: e.iccid,
        bundleName: e.bundleName,
        dataRemainingMb: e.dataRemainingMb,
        provider: e.provider,
        expiresAt: e.expiresAt,
        createdAt: e.createdAt,
      })),
      page,
      limit,
      total,
    });
  };

  listEsimOrders = async (req: Request, res: Response) => {
    const { page, limit, skip } = parsePagination(req);
    const [total, items] = await Promise.all([
      prisma.esimOrder.count(),
      prisma.esimOrder.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          esim: {
            select: {
              id: true,
              bundleName: true,
              status: true,
              userId: true,
              user: { select: { id: true, email: true, firstName: true, lastName: true } },
            },
          },
          transaction: { select: { id: true, amount: true, currency: true, userId: true } },
        },
      }),
    ]);
    return ok(res, {
      orders: items.map(({ esim, transaction, ...o }) => {
        const user = esim?.user;
        return {
          id: o.id,
          userId: esim?.userId ?? transaction.userId,
          userEmail: user?.email ?? null,
          userName: user ? userDisplayName(user) : null,
          esimId: o.esimId,
          bundleName: o.bundleName,
          esimStatus: esim?.status ?? null,
          amount: Number(transaction.amount),
          currency: transaction.currency,
          status: o.status,
          orderReference: o.orderReference,
          transactionId: o.transactionId,
          createdAt: o.createdAt,
        };
      }),
      page,
      limit,
      total,
    });
  };

  listReferrals = async (req: Request, res: Response) => {
    const { page, limit, skip } = parsePagination(req);
    const [total, items] = await Promise.all([
      prisma.referralAttribution.count(),
      prisma.referralAttribution.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          referrer: { select: { id: true, email: true, firstName: true, lastName: true } },
          referred: { select: { id: true, email: true, firstName: true, lastName: true } },
        },
      }),
    ]);
    return ok(res, {
      referrals: items.map((r) => ({
        id: r.id,
        code: r.code,
        status: r.status,
        rewardAmount: Number(r.rewardAmount),
        createdAt: r.createdAt,
        referrerId: r.referrerUserId,
        referrerEmail: r.referrer.email,
        referrerName: userDisplayName(r.referrer),
        refereeId: r.referredUserId,
        refereeEmail: r.referred.email,
        refereeName: userDisplayName(r.referred),
      })),
      page,
      limit,
      total,
    });
  };

  listWebhooks = async (req: Request, res: Response) => {
    const { page, limit, skip } = parsePagination(req);
    const [total, items] = await Promise.all([
      prisma.webhookEvent.count(),
      prisma.webhookEvent.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
    ]);
    return ok(res, {
      events: items.map((e) => ({
        id: e.id,
        provider: e.provider,
        eventType: e.eventType,
        processed: e.processed,
        error: e.error,
        createdAt: e.createdAt,
      })),
      page,
      limit,
      total,
    });
  };

  listStaff = async (_req: Request, res: Response) => {
    const staff = await prisma.adminUser.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        active: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return ok(res, { staff });
  };

  listClosures = async (req: Request, res: Response) => {
    const { page, limit, skip } = parsePagination(req);
    const [total, items] = await Promise.all([
      prisma.closureRequest.count(),
      prisma.closureRequest.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
      }),
    ]);
    return ok(res, {
      requests: items.map(({ user, ...r }) => ({
        ...r,
        userEmail: user.email,
        userName: userDisplayName(user),
      })),
      page,
      limit,
      total,
    });
  };

  listDevices = async (req: Request, res: Response) => {
    const { page, limit, skip } = parsePagination(req);
    const [total, items] = await Promise.all([
      prisma.refreshToken.count(),
      prisma.refreshToken.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
      }),
    ]);
    return ok(res, {
      devices: items.map(({ user, tokenHash: _h, ...t }) => ({
        id: t.id,
        userId: t.userId,
        userEmail: user.email,
        userName: userDisplayName(user),
        deviceLabel: t.deviceLabel,
        userAgent: t.userAgent,
        lastSeenAt: t.lastSeenAt,
        createdAt: t.createdAt,
        expiresAt: t.expiresAt,
        revokedAt: t.revokedAt,
      })),
      page,
      limit,
      total,
    });
  };

  listPlatformConfig = async (_req: Request, res: Response) => {
    const rows = await prisma.platformConfig.findMany({ orderBy: { key: "asc" } });
    return ok(res, {
      config: rows.map((r) => ({
        key: r.key,
        value: r.value,
        updatedAt: r.updatedAt,
      })),
    });
  };

  upsertPlatformConfig = async (req: Request, res: Response) => {
    const key = typeof req.body?.key === "string" ? req.body.key.trim() : "";
    const value = typeof req.body?.value === "string" ? req.body.value : req.body?.value != null ? String(req.body.value) : "";
    if (!key) throw new AppError("key is required", 400, "BAD_REQUEST");
    const row = await prisma.platformConfig.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
    return ok(res, { key: row.key, value: row.value, updatedAt: row.updatedAt });
  };

  updateClosure = async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const status = String(req.body?.status ?? "").toUpperCase();
    if (status !== "PROCESSED" && status !== "CANCELLED" && status !== "PENDING") {
      throw new AppError("status must be PENDING, PROCESSED, or CANCELLED", 400, "BAD_REQUEST");
    }
    const existing = await prisma.closureRequest.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Closure request not found");
    const updated = await prisma.closureRequest.update({
      where: { id },
      data: { status: status as "PENDING" | "PROCESSED" | "CANCELLED" },
      include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
    });
    const { user, ...r } = updated;
    return ok(res, {
      request: {
        ...r,
        userEmail: user.email,
        userName: userDisplayName(user),
      },
    });
  };

  revokeDevice = async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const token = await prisma.refreshToken.findUnique({ where: { id } });
    if (!token) throw new NotFoundError("Device session not found");
    const updated = await prisma.refreshToken.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    return ok(res, {
      device: {
        id: updated.id,
        revokedAt: updated.revokedAt,
      },
    });
  };

  supportStats = async (_req: Request, res: Response) => {
    const [open, closed, total, recent] = await Promise.all([
      prisma.supportTicket.count({ where: { status: "OPEN" } }),
      prisma.supportTicket.count({ where: { status: "CLOSED" } }),
      prisma.supportTicket.count(),
      prisma.supportTicket.findMany({
        orderBy: { updatedAt: "desc" },
        take: 10,
        include: {
          user: { select: { email: true, firstName: true, lastName: true } },
          messages: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      }),
    ]);
    return ok(res, {
      open,
      closed,
      total,
      recent: recent.map((t) => ({
        id: t.id,
        topic: t.topic,
        status: t.status,
        userEmail: t.user.email,
        userName: userDisplayName(t.user),
        updatedAt: t.updatedAt,
        lastMessage: t.messages[0]?.body ?? null,
      })),
    });
  };

  revenueSummary = async (_req: Request, res: Response) => {
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const fees = await prisma.transaction.groupBy({
      by: ["currency", "type"],
      where: { createdAt: { gte: since30d }, status: "SUCCESS" },
      _sum: { fee: true, amount: true },
      _count: { _all: true },
    });
    return ok(res, {
      since: since30d.toISOString(),
      lines: fees.map((f) => ({
        currency: f.currency,
        type: f.type,
        feeTotal: Number(f._sum.fee ?? 0),
        volume: Number(f._sum.amount ?? 0),
        count: f._count._all,
      })),
    });
  };
}

export const adminOpsController = new AdminOpsController();
