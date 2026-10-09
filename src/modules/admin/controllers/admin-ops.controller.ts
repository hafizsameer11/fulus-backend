import type { Request, Response } from "express";
import { z } from "zod";
import { ok } from "../../../lib/http.js";
import { AppError, NotFoundError, UnauthorizedError } from "../../../lib/errors.js";
import { prisma } from "../../../lib/prisma.js";
import { parsePagination } from "../lib/pagination.js";
import {
  cryptoAssetConfigSchema,
  cryptoAssetConfigService,
} from "../../crypto/services/crypto-asset-config.service.js";
import { cryptoService } from "../../crypto/services/crypto.service.js";
import { billsService } from "../../bills/services/bills.service.js";
import { destinationsFromBundles, esimService } from "../../esim/services/esim.service.js";
import { ADMIN_ROLES } from "../lib/roles.js";
import { adminStaffService } from "../services/admin-staff.service.js";

const roleEnum = z.enum([
  "super_admin",
  "support_agent",
  "support_lead",
  "compliance",
  "payment_ops",
  "finance",
  "growth",
  "product_admin",
  "auditor",
]);

const inviteStaffSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(120),
  role: roleEnum,
  password: z.string().min(10).max(128).optional(),
});

const patchStaffSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  role: roleEnum.optional(),
  active: z.boolean().optional(),
  password: z.string().min(10).max(128).optional(),
});

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
    return ok(res, { services: await billsService.adminListServices() });
  };

  listBillProducts = async (_req: Request, res: Response) => {
    return ok(res, { products: await billsService.adminListProducts() });
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
    const userId = typeof req.query.userId === "string" ? req.query.userId : undefined;
    const where = userId ? { userId } : {};
    const [total, items] = await Promise.all([
      prisma.billPayment.count({ where }),
      prisma.billPayment.findMany({
        where,
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
    const userId = typeof req.query.userId === "string" ? req.query.userId : undefined;
    const where = userId ? { userId } : {};
    const [total, items] = await Promise.all([
      prisma.cryptoOrder.count({ where }),
      prisma.cryptoOrder.findMany({
        where,
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
    const userId = typeof req.query.userId === "string" ? req.query.userId : undefined;
    const where = userId ? { userId } : {};
    const [total, items] = await Promise.all([
      prisma.cryptoAddress.count({ where }),
      prisma.cryptoAddress.findMany({
        where,
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
    const holdBy = await cryptoService.aggregateCustomerHoldings();
    const wallets = [...holdBy.entries()]
      .filter(([, h]) => h.customerHoldings > 0 || h.holders > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, h]) => ({
        currency,
        available: Math.max(0, h.customerHoldings - h.pending),
        pending: h.pending,
        holders: h.holders,
      }));
    return ok(res, { wallets });
  };

  /** Asset registry: Busha mid + Fulus buy/sell spreads + customer holdings. */
  listCryptoAssets = async (_req: Request, res: Response) => {
    const [rates, configs, holdBy] = await Promise.all([
      cryptoService.rates(),
      cryptoAssetConfigService.list(),
      cryptoService.aggregateCustomerHoldings(),
    ]);
    const rateBy = new Map(
      (rates as Array<Record<string, unknown>>).map((r) => [String(r.currency).toUpperCase(), r]),
    );
    const codes = new Set<string>([
      ...configs.map((c) => c.code),
      ...rateBy.keys(),
      ...holdBy.keys(),
    ]);
    const assets = [...codes].sort().map((code) => {
      const cfg = configs.find((c) => c.code === code) ?? {
        code,
        enabled: true,
        buyEnabled: true,
        sellEnabled: true,
        sendEnabled: true,
        buySpreadBps: 0,
        sellSpreadBps: 0,
        minTradeUsd: 2,
        maxTradeUsd: 100_000,
      };
      const rate = rateBy.get(code) ?? {};
      const hold = holdBy.get(code) ?? { customerHoldings: 0, holders: 0 };
      const priceUsd = Number(rate.usd ?? 0);
      return {
        code,
        enabled: cfg.enabled,
        buyEnabled: cfg.buyEnabled,
        sellEnabled: cfg.sellEnabled,
        sendEnabled: cfg.sendEnabled,
        buySpreadBps: cfg.buySpreadBps,
        sellSpreadBps: cfg.sellSpreadBps,
        minTradeUsd: cfg.minTradeUsd,
        maxTradeUsd: cfg.maxTradeUsd,
        priceUsd,
        buyUsd: Number(rate.buyUsd ?? 0) || priceUsd * (1 + cfg.buySpreadBps / 10_000),
        sellUsd: Number(rate.sellUsd ?? 0) || priceUsd * (1 - cfg.sellSpreadBps / 10_000),
        ngn: Number(rate.ngn ?? 0),
        buyNgn: Number(rate.buyNgn ?? 0),
        sellNgn: Number(rate.sellNgn ?? 0),
        bushaBuyNgn: Number(rate.bushaBuyNgn ?? rate.ngn ?? 0),
        bushaSellNgn: Number(rate.bushaSellNgn ?? rate.ngn ?? 0),
        provider: rate.provider ?? "busha",
        customerHoldings: hold.customerHoldings,
        holders: hold.holders,
        updatedAt: cfg.updatedAt ?? null,
      };
    });
    return ok(res, { assets });
  };

  upsertCryptoAsset = async (req: Request, res: Response) => {
    const code = String(req.params.code ?? req.body?.code ?? "").toUpperCase();
    if (!code) throw new AppError("code is required", 400, "BAD_REQUEST");
    const input = cryptoAssetConfigSchema.parse({ ...req.body, code });
    const asset = await cryptoAssetConfigService.upsert(input);
    return ok(res, { asset });
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

  /**
   * Live eSIM Go catalogue for ops, overlaid with DB sold/stock counts.
   * Never returns admin UI demo seed rows.
   */
  esimCatalogue = async (req: Request, res: Response) => {
    const query = Object.fromEntries(
      Object.entries(req.query).map(([k, v]) => [k, Array.isArray(v) ? String(v[0]) : String(v ?? "")]),
    );
    const catalogue = await esimService.catalogue(query);
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [orders30d, esims] = await Promise.all([
      prisma.esimOrder.findMany({
        where: { createdAt: { gte: since30d } },
        select: { bundleName: true, status: true },
      }),
      prisma.esim.findMany({
        select: { bundleName: true, status: true },
      }),
    ]);

    const soldBy = new Map<string, number>();
    for (const o of orders30d) {
      const key = o.bundleName || "unknown";
      soldBy.set(key, (soldBy.get(key) ?? 0) + 1);
    }

    const stockBy = new Map<string, number>();
    for (const e of esims) {
      const key = e.bundleName || "unknown";
      const st = String(e.status).toUpperCase();
      if (st === "FAILED" || st === "EXPIRED" || st === "CANCELLED") continue;
      stockBy.set(key, (stockBy.get(key) ?? 0) + 1);
    }

    const mode = String(query.mode || "destinations").toLowerCase();

    const bundlePlans = catalogue.bundles.map((b) => {
      const networks = b.countries.flatMap((c) => (c.networks ?? []).map((n) => n.brandName || n.name)).filter(Boolean);
      const carrier = networks[0] || "eSIM Go";
      const primaryIso = b.countries[0]?.iso ?? "";
      const region =
        b.countries.length === 1
          ? b.countries[0]!.name
          : b.countries[0]?.region || b.description || b.name;
      const priceUsd = Number(b.price) || 0;
      return {
        id: b.name,
        bundleName: b.name,
        description: b.description,
        region,
        flagIso: primaryIso,
        countries: b.countries.length,
        dataMb: b.dataMb,
        unlimited: b.unlimited,
        days: b.days,
        priceUsd,
        costUsd: Math.round(priceUsd * 0.7 * 100) / 100,
        carrier,
        inventory: stockBy.get(b.name) ?? 0,
        reorderAt: 0,
        sold30d: soldBy.get(b.name) ?? 0,
        enabled: true,
        provider: catalogue.provider,
        currency: b.currency || "USD",
        countryList: b.countries.map((c) => ({ iso: c.iso, name: c.name })),
        planCount: 1,
      };
    });

    /** Destination cards for the desk (same grouping as the consumer app). */
    const dests = catalogue.destinations?.length
      ? catalogue.destinations
      : destinationsFromBundles(catalogue.bundles);

    // Aggregate DB stats onto destinations via bundle membership (iso / region key).
    const destPlans = dests.map((d) => {
      const memberBundles = catalogue.bundles.filter((b) => {
        if (d.iso) {
          return b.countries.some((c) => c.iso.toLowerCase() === d.iso!.toLowerCase());
        }
        // Regional / global groups: match region label or multi-country emblem destinations
        const regionHit = b.countries.some((c) => c.region.toLowerCase() === d.regionLabel.toLowerCase());
        if (d.key === "gl" || d.emblem === "global") return b.countries.length >= 10;
        if (d.emblem === "africa" || d.key === "af") {
          return b.countries.length > 1 && b.countries.every((c) => c.region.toLowerCase().includes("africa"));
        }
        if (d.key === "eu" || d.name === "Europe") {
          return b.countries.length > 1 && b.countries.every((c) => c.region.toLowerCase().includes("europe"));
        }
        return regionHit && b.countries.length === 1;
      });
      const names = new Set(memberBundles.map((b) => b.name));
      let sold30d = 0;
      let inventory = 0;
      for (const name of names) {
        sold30d += soldBy.get(name) ?? 0;
        inventory += stockBy.get(name) ?? 0;
      }
      // Fallback: if membership filter was too strict, use destination planCount only
      const priceUsd = Number(d.from) || 0;
      return {
        id: `dest:${d.key}`,
        bundleName: d.key,
        description: `${d.planCount} eSIM Go bundles`,
        region: d.name,
        flagIso: (d.iso || "").toUpperCase(),
        countries: d.countries,
        dataMb: 0,
        unlimited: false,
        days: 0,
        priceUsd,
        costUsd: Math.round(priceUsd * 0.7 * 100) / 100,
        carrier: "eSIM Go",
        inventory,
        reorderAt: 0,
        sold30d,
        enabled: true,
        provider: catalogue.provider,
        currency: "USD",
        countryList: d.countryList ?? [],
        planCount: d.planCount,
      };
    });

    const plans = mode === "bundles" ? bundlePlans : destPlans;

    return ok(res, {
      plans,
      bundles: bundlePlans.length,
      destinations: dests.length,
      provider: catalogue.provider,
      simulated: catalogue.simulated,
      count: plans.length,
      mode: mode === "bundles" ? "bundles" : "destinations",
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
    return ok(res, { staff: await adminStaffService.list(), roles: ADMIN_ROLES });
  };

  createStaff = async (req: Request, res: Response) => {
    if (!req.admin) throw new UnauthorizedError();
    const input = inviteStaffSchema.parse(req.body ?? {});
    const result = await adminStaffService.create(req.admin, input);
    return ok(res, result, 201);
  };

  patchStaff = async (req: Request, res: Response) => {
    if (!req.admin) throw new UnauthorizedError();
    const id = String(req.params.id ?? "");
    if (!id) throw new AppError("Staff id required", 400);
    const input = patchStaffSchema.parse(req.body ?? {});
    const staff = await adminStaffService.update(req.admin, id, input);
    return ok(res, { staff });
  };

  offboardStaff = async (req: Request, res: Response) => {
    if (!req.admin) throw new UnauthorizedError();
    const id = String(req.params.id ?? "");
    if (!id) throw new AppError("Staff id required", 400);
    const staff = await adminStaffService.offboard(req.admin, id);
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

  listAudit = async (req: Request, res: Response) => {
    const { page, limit, skip } = parsePagination(req);
    const [total, items] = await Promise.all([
      prisma.adminAuditLog.count(),
      prisma.adminAuditLog.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
    ]);
    return ok(res, {
      entries: items.map((e) => ({
        id: e.id,
        actor: e.actor,
        action: e.action,
        subjectId: e.subjectId,
        detail: e.detail,
        createdAt: e.createdAt,
      })),
      page,
      limit,
      total,
    });
  };
}

export const adminOpsController = new AdminOpsController();
