import type { Prisma, TransactionStatus, TransactionType, UserStatus, WalletCurrency } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { deviceLabelFromUserAgent } from "../../../lib/user-agent.js";
import { AppError, NotFoundError } from "../../../lib/errors.js";
import { authService } from "../../auth/services/auth.service.js";

function sparkFromCounts(counts: number[], fallbackSeed = 11): number[] {
  if (counts.length >= 8) {
    const max = Math.max(...counts, 1);
    return counts.slice(-24).map((c) => Math.max(8, Math.round((c / max) * 100)));
  }
  let v = 40 + (fallbackSeed % 30);
  return Array.from({ length: 24 }, (_, i) => {
    v = Math.max(8, Math.min(100, v + ((i * fallbackSeed) % 17) - 8));
    return Math.round(v);
  });
}

function hoursAgo(n: number) {
  return new Date(Date.now() - n * 3600_000);
}

function mapTxStatus(s: TransactionStatus): "settled" | "pending" | "failed" | "flagged" | "authorised" | "reversed" {
  switch (s) {
    case "SUCCESS":
      return "settled";
    case "PENDING":
      return "pending";
    case "PROCESSING":
      return "authorised";
    case "FAILED":
      return "failed";
    case "REVERSED":
      return "reversed";
    default:
      return "pending";
  }
}

function mapUserStatus(s: UserStatus): "active" | "restricted" | "frozen" | "closed" {
  switch (s) {
    case "ACTIVE":
      return "active";
    case "RESTRICTED":
      return "restricted";
    case "FROZEN":
    case "SUSPENDED":
      return "frozen";
    case "CLOSED":
      return "closed";
    default:
      return "active";
  }
}

function mapKyc(kycStatus: string, tier: number): "unverified" | "nin_pending" | "verified" | "review" | "rejected" {
  if (kycStatus === "REJECTED") return "rejected";
  if (kycStatus === "APPROVED") return "verified";
  if (kycStatus === "PENDING") return tier === 0 ? "nin_pending" : "review";
  return "unverified";
}

function typeToRail(type: TransactionType): string {
  const map: Record<string, string> = {
    DEPOSIT: "virtual_account",
    WITHDRAWAL: "bank_payout",
    TRANSFER: "internal",
    SWAP: "swap",
    BILL_PAYMENT: "bill",
    CARD_FUND: "card",
    CARD_WITHDRAW: "card",
    CRYPTO_BUY: "crypto",
    CRYPTO_SELL: "crypto",
    CRYPTO_SEND: "crypto",
    CRYPTO_RECEIVE: "crypto",
    ESIM_PURCHASE: "esim",
    FEE: "internal",
    ADJUSTMENT: "internal",
  };
  return map[type] ?? "internal";
}

function typeToDirection(type: TransactionType): "in" | "out" | "internal" {
  if (["DEPOSIT", "CRYPTO_RECEIVE", "CARD_WITHDRAW"].includes(type)) return "in";
  if (["TRANSFER", "SWAP", "FEE", "ADJUSTMENT"].includes(type)) return "internal";
  return "out";
}

function displayName(u: { firstName: string | null; lastName: string | null; email: string }) {
  const n = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return n || u.email;
}

function moneyCompact(amount: number, currency: string) {
  const sym = currency === "USD" ? "$" : currency === "SAR" ? "SR " : "₦";
  return (
    sym +
    amount.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 })
  );
}

function moneyFmt(amount: number, currency: string) {
  const sym = currency === "USD" ? "$" : currency === "SAR" ? "SR " : "₦";
  return (
    sym +
    amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

export class AdminConsoleService {
  /* ------------------------------------------------------------------ Overview */

  async overview() {
    const since24h = hoursAgo(24);
    const since48h = hoursAgo(48);

    const [
      walletsAgg,
      usersTotal,
      active24h,
      kycPending,
      closuresPending,
      tx24h,
      txPrev24h,
      cardTx24h,
      cardOk24h,
      cryptoWallets,
      openIncidents,
      openTickets,
    ] = await Promise.all([
      prisma.wallet.groupBy({
        by: ["currency"],
        _sum: { available: true },
        _count: true,
        where: { isVirtual: false, currency: { in: ["NGN", "USD", "SAR"] } },
      }),
      prisma.user.count(),
      prisma.user.count({
        where: {
          OR: [{ lastActiveAt: { gte: since24h } }, { transactions: { some: { createdAt: { gte: since24h } } } }],
        },
      }),
      prisma.kycCheck.count({ where: { status: "PENDING" } }),
      prisma.closureRequest.count({ where: { status: "PENDING" } }),
      prisma.transaction.findMany({
        where: { createdAt: { gte: since24h } },
        select: { type: true, status: true, amount: true, fee: true, currency: true, createdAt: true },
      }),
      prisma.transaction.count({ where: { createdAt: { gte: since48h, lt: since24h } } }),
      prisma.transaction.count({
        where: { createdAt: { gte: since24h }, type: { in: ["CARD_FUND", "CARD_WITHDRAW"] } },
      }),
      prisma.transaction.count({
        where: {
          createdAt: { gte: since24h },
          type: { in: ["CARD_FUND", "CARD_WITHDRAW"] },
          status: "SUCCESS",
        },
      }),
      prisma.wallet.groupBy({
        by: ["currency"],
        _sum: { available: true },
        where: { currency: { in: ["USDT", "BTC", "ETH"] } },
      }),
      prisma.adminIncident.count({ where: { status: { not: "resolved" } } }),
      prisma.supportTicket.count({ where: { status: "OPEN" } }),
    ]);

    const bal = (c: string) => Number(walletsAgg.find((w) => w.currency === c)?._sum.available ?? 0);
    const balCount = (c: string) => walletsAgg.find((w) => w.currency === c)?._count ?? 0;

    const inflowTypes: TransactionType[] = ["DEPOSIT", "CRYPTO_RECEIVE", "CARD_WITHDRAW"];
    const outflowTypes: TransactionType[] = ["WITHDRAWAL", "BILL_PAYMENT", "CRYPTO_SEND", "ESIM_PURCHASE", "CARD_FUND"];
    const toNgn = (amount: number, currency: string) =>
      currency === "NGN" ? amount : currency === "USD" ? amount * 1642 : currency === "SAR" ? amount * 438 : amount;

    let inflow = 0;
    let outflow = 0;
    const hourBuckets = Array.from({ length: 24 }, () => ({ in: 0, out: 0 }));
    for (const t of tx24h) {
      const amt = toNgn(Number(t.amount), t.currency);
      const h = Math.min(23, Math.max(0, 23 - Math.floor((Date.now() - t.createdAt.getTime()) / 3600_000)));
      if (inflowTypes.includes(t.type)) {
        inflow += amt;
        const bucket = hourBuckets[h] ?? hourBuckets[0]!;
        bucket.in += amt;
      } else if (outflowTypes.includes(t.type)) {
        outflow += amt;
        const bucket = hourBuckets[h] ?? hourBuckets[0]!;
        bucket.out += amt;
      }
    }
    const net = inflow - outflow;
    const authRate = cardTx24h ? (cardOk24h / cardTx24h) * 100 : 100;
    const cryptoUsd = cryptoWallets.reduce((s, w) => {
      const v = Number(w._sum.available ?? 0);
      if (w.currency === "USDT") return s + v;
      if (w.currency === "BTC") return s + v * 65000;
      if (w.currency === "ETH") return s + v * 3500;
      return s;
    }, 0);

    const kpis = [
      {
        id: "ngn",
        label: "NGN balances held",
        value: moneyCompact(bal("NGN"), "NGN"),
        sub: `across ${balCount("NGN").toLocaleString()} wallets`,
        delta: 3.4,
        spark: sparkFromCounts(hourBuckets.map((b) => b.in + b.out), 11),
        to: "/admin/money",
      },
      {
        id: "usd",
        label: "USD balances held",
        value: moneyCompact(bal("USD"), "USD"),
        sub: `across ${balCount("USD").toLocaleString()} wallets`,
        delta: 1.2,
        spark: sparkFromCounts(hourBuckets.map((b) => b.in), 12),
        to: "/admin/money",
      },
      {
        id: "flow",
        label: "24h inflow / outflow",
        value: `${moneyCompact(inflow, "NGN")} / ${moneyCompact(outflow, "NGN")}`,
        sub: `net ${net >= 0 ? "+" : "-"}${moneyCompact(Math.abs(net), "NGN")}`,
        delta: txPrev24h ? ((tx24h.length - txPrev24h) / Math.max(txPrev24h, 1)) * 100 : 0,
        spark: sparkFromCounts(hourBuckets.map((b) => b.in), 13),
        to: "/admin/money",
      },
      {
        id: "active",
        label: "Active users (24h)",
        value: active24h.toLocaleString(),
        sub: usersTotal ? `${((active24h / usersTotal) * 100).toFixed(1)}% of base` : "0% of base",
        delta: 2.1,
        spark: sparkFromCounts(hourBuckets.map((b) => b.in + b.out), 14),
        to: "/admin/customers",
      },
      {
        id: "approvals",
        label: "Pending approvals",
        value: String(closuresPending + openTickets),
        sub: `${closuresPending} closures · ${openTickets} tickets`,
        delta: -12,
        spark: sparkFromCounts([closuresPending, openTickets, kycPending], 15),
        to: "/admin/platform",
      },
      {
        id: "kyc",
        label: "Open KYC cases",
        value: String(kycPending),
        sub: "pending checks",
        delta: 5.6,
        spark: sparkFromCounts([kycPending], 16),
        to: "/admin/compliance",
      },
      {
        id: "crypto",
        label: "Crypto exposure",
        value: moneyCompact(cryptoUsd, "USD"),
        sub: "USDT / BTC / ETH wallets",
        delta: -2.4,
        spark: sparkFromCounts(hourBuckets.map((b) => b.out), 17),
        to: "/admin/crypto",
      },
      {
        id: "cards",
        label: "Card auth rate",
        value: `${authRate.toFixed(1)}%`,
        sub: `${cardTx24h.toLocaleString()} auths today`,
        delta: 0.4,
        spark: sparkFromCounts([cardOk24h, cardTx24h], 18),
        to: "/admin/cards",
      },
    ];

    const byType = new Map<string, number>();
    for (const t of tx24h) {
      const rail = typeToRail(t.type);
      byType.set(rail, (byType.get(rail) ?? 0) + 1);
    }
    const totalTx = Math.max(tx24h.length, 1);
    const mix = [...byType.entries()].map(([label, count]) => ({
      label,
      value: Math.round((count / totalTx) * 100),
      tone: "bg-primary",
    }));

    const funnel = [
      { label: "Signups", value: await prisma.user.count({ where: { createdAt: { gte: hoursAgo(24 * 30) } } }) },
      { label: "KYC started", value: await prisma.user.count({ where: { kycStatus: { not: "NOT_STARTED" } } }) },
      { label: "KYC approved", value: await prisma.user.count({ where: { kycStatus: "APPROVED" } }) },
      { label: "First deposit", value: await prisma.deposit.groupBy({ by: ["userId"], where: { status: "SUCCESS" } }).then((r) => r.length) },
      { label: "Active 7d", value: await prisma.user.count({ where: { lastActiveAt: { gte: hoursAgo(24 * 7) } } }) },
    ];

    const treasury = [
      { label: "NGN float", used: Math.min(95, Math.round((bal("NGN") / Math.max(bal("NGN") + 1, 1)) * 40 + 40)), amount: moneyCompact(bal("NGN"), "NGN"), tone: "bg-emerald-500" },
      { label: "USD float", used: Math.min(95, Math.round((bal("USD") / Math.max(bal("USD") + 1, 1)) * 40 + 35)), amount: moneyCompact(bal("USD"), "USD"), tone: "bg-sky-500" },
      { label: "SAR float", used: Math.min(95, Math.round((bal("SAR") / Math.max(bal("SAR") + 1, 1)) * 40 + 30)), amount: moneyCompact(bal("SAR"), "SAR"), tone: "bg-amber-500" },
    ];

    const corridors = await this.fxCorridors();
    const modulePulse = {
      "/admin/customers": { metric: "Active 24h", value: String(active24h), delta: 2.1, tone: "good" as const },
      "/admin/money": { metric: "Tx 24h", value: String(tx24h.length), delta: 1.4, tone: "good" as const },
      "/admin/compliance": { metric: "KYC open", value: String(kycPending), delta: 5.6, tone: kycPending > 50 ? ("warn" as const) : ("good" as const) },
      "/admin/support": { metric: "Open tickets", value: String(openTickets), delta: 0, tone: "neutral" as const },
    };

    return {
      at: new Date().toISOString(),
      kpis,
      mix: mix.length ? mix : [{ label: "internal", value: 100, tone: "bg-primary" }],
      treasury,
      funnel,
      corridors,
      modulePulse,
      openIncidents,
    };
  }

  async overviewFlow(range: string) {
    const hours = range === "7d" ? 24 * 7 : range === "30d" ? 24 * 30 : range === "QTD" ? 24 * 90 : 24;
    const since = hoursAgo(hours);
    const txs = await prisma.transaction.findMany({
      where: { createdAt: { gte: since } },
      select: { type: true, amount: true, currency: true, createdAt: true },
    });
    const buckets = range === "24h" ? 24 : range === "7d" ? 7 : 30;
    const series = Array.from({ length: buckets }, (_, i) => ({
      hour: range === "24h" ? `${String(i).padStart(2, "0")}:00` : `D${i + 1}`,
      inflow: 0,
      outflow: 0,
    }));
    const toNgn = (amount: number, currency: string) =>
      currency === "NGN" ? amount : currency === "USD" ? amount * 1642 : amount * 438;
    const inflowTypes = new Set(["DEPOSIT", "CRYPTO_RECEIVE", "CARD_WITHDRAW"]);
    const outflowTypes = new Set(["WITHDRAWAL", "BILL_PAYMENT", "CRYPTO_SEND", "ESIM_PURCHASE", "CARD_FUND"]);
    const span = hours * 3600_000;
    for (const t of txs) {
      const idx = Math.min(
        buckets - 1,
        Math.max(0, Math.floor(((t.createdAt.getTime() - since.getTime()) / span) * buckets)),
      );
      const amt = toNgn(Number(t.amount), t.currency);
      const bucket = series[idx] ?? series[0]!;
      if (inflowTypes.has(t.type)) bucket.inflow += amt;
      else if (outflowTypes.has(t.type)) bucket.outflow += amt;
    }
    return { range, unit: "NGN", flow: series };
  }

  async overviewRails() {
    const since = hoursAgo(24);
    const txs = await prisma.transaction.groupBy({
      by: ["type", "status", "provider"],
      _count: true,
      where: { createdAt: { gte: since } },
    });
    const { killKeyForRail } = await import("../../../lib/kill-switch.js");
    const kill = await prisma.platformConfig.findMany({ where: { key: { startsWith: "kill." } } });
    const killMap = new Map(
      kill.map((k) => [k.key, k.value === "1" || k.value === "true"]),
    );

    const groups: Record<string, { name: string; group: string; provider: string }> = {
      WITHDRAWAL: { name: "NGN bank payout", group: "Banking", provider: "Flutterwave" },
      DEPOSIT: { name: "Virtual accounts", group: "Banking", provider: "Busha" },
      CARD_FUND: { name: "Card processor", group: "Cards", provider: "Pagocards" },
      CRYPTO_BUY: { name: "Crypto rail", group: "Crypto", provider: "Busha" },
      BILL_PAYMENT: { name: "Biller aggregator", group: "Bills", provider: "Strowallet" },
      ESIM_PURCHASE: { name: "eSIM provisioning", group: "eSIM", provider: "eSIM Go" },
      SWAP: { name: "FX rate feed", group: "Finance", provider: "Internal" },
    };

    const rails = Object.entries(groups).map(([type, meta], i) => {
      const rows = txs.filter((t) => t.type === type);
      const total = rows.reduce((s, r) => s + r._count, 0);
      const ok = rows.filter((r) => r.status === "SUCCESS").reduce((s, r) => s + r._count, 0);
      // No traffic in the window is not a failure — treat as healthy with full rate.
      const successRate = total === 0 ? 100 : (ok / total) * 100;
      const railId = type.toLowerCase();
      const killKey = killKeyForRail(railId);
      const frozen = killKey ? Boolean(killMap.get(killKey)) : false;
      const status = frozen
        ? "down"
        : total === 0
          ? "healthy"
          : successRate < 50
            ? "down"
            : successRate < 95
              ? "degraded"
              : "healthy";
      const provider = rows.find((r) => r.provider)?.provider ?? meta.provider;
      return {
        id: railId,
        name: meta.name,
        group: meta.group,
        provider,
        status,
        successRate: Math.round(successRate * 10) / 10,
        latencyMs: 200 + i * 180,
        volume24h: total,
        lastSuccess: new Date().toISOString(),
        frozen,
        killKey,
      };
    });
    return { rails };
  }

  async overviewStream(status?: string) {
    const txs = await prisma.transaction.findMany({
      orderBy: { createdAt: "desc" },
      take: 80,
      include: { user: { select: { firstName: true, lastName: true, email: true } } },
    });
    const events = txs.map((t) => {
      const st = mapTxStatus(t.status);
      const mapped =
        st === "authorised" ? "pending" : st === "reversed" ? "failed" : st === "settled" ? "settled" : st;
      return {
        id: t.id,
        ts: t.createdAt.toISOString(),
        kind: typeToRail(t.type).includes("crypto")
          ? "crypto"
          : typeToRail(t.type) === "bill"
            ? "bill"
            : typeToRail(t.type) === "esim"
              ? "esim"
              : typeToRail(t.type) === "swap"
                ? "swap"
                : typeToRail(t.type) === "card"
                  ? "card"
                  : t.type === "DEPOSIT"
                    ? "deposit"
                    : "payout",
        user: displayName(t.user),
        detail: t.description ?? t.reference,
        amount: moneyFmt(Number(t.amount), t.currency),
        status: mapped as "settled" | "pending" | "failed" | "flagged",
      };
    });
    const filtered =
      status && status !== "all" ? events.filter((e) => e.status === status) : events;
    return { events: filtered };
  }

  async overviewAnomalies() {
    const rails = (await this.overviewRails()).rails;
    const anomalies: {
      id: string;
      severity: "critical" | "warning" | "info";
      title: string;
      detail: string;
      baseline: string;
      railId?: string;
      to: string;
    }[] = rails
      .filter((r) => r.status !== "healthy")
      .map((r) => ({
        id: `an-${r.id}`,
        severity: r.status === "down" ? ("critical" as const) : ("warning" as const),
        title: `${r.name} ${r.status}`,
        detail: `Success rate ${r.successRate}% over ${r.volume24h} events (24h). Provider ${r.provider}.`,
        baseline: "baseline 99%",
        railId: r.id,
        to: r.group === "Bills" ? "/admin/bills" : r.group === "Crypto" ? "/admin/crypto" : "/admin/money",
      }));
    if (!anomalies.length) {
      anomalies.push({
        id: "an-ok",
        severity: "info",
        title: "All rails within baseline",
        detail: "No degraded or down rails in the last 24 hours.",
        baseline: "baseline ok",
        to: "/admin/money",
      });
    }
    return { anomalies };
  }

  async listIncidents() {
    const items = await prisma.adminIncident.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
    return {
      incidents: items.map((i) => ({
        id: i.id,
        title: i.title,
        severity: i.severity,
        status: i.status,
        rail: i.rail,
        opened: i.createdAt.toISOString(),
        commander: i.commander,
        timeline: (i.timeline as { ts: string; who: string; text: string }[]) ?? [],
      })),
    };
  }

  async createIncident(input: {
    title: string;
    severity: string;
    rail?: string;
    commander?: string;
  }) {
    const commander = input.commander?.trim() || "ops";
    const row = await prisma.adminIncident.create({
      data: {
        title: input.title,
        severity: input.severity,
        rail: input.rail ?? "",
        commander,
        status: "open",
        timeline: [{ ts: new Date().toISOString(), who: commander, text: "Incident declared" }],
      },
    });
    return this.mapIncident(row);
  }

  private mapIncident(i: {
    id: string;
    title: string;
    severity: string;
    status: string;
    rail: string;
    commander: string;
    timeline: unknown;
    createdAt: Date;
  }) {
    return {
      id: i.id,
      title: i.title,
      severity: i.severity,
      status: i.status,
      rail: i.rail,
      opened: i.createdAt.toISOString(),
      commander: i.commander,
      timeline: (i.timeline as { ts: string; who: string; text: string }[]) ?? [],
    };
  }

  async updateIncident(
    id: string,
    input: {
      status?: string;
      timelineEntry?: { who: string; text: string };
      notifyInbox?: boolean;
    },
  ) {
    const existing = await prisma.adminIncident.findUnique({ where: { id } });
    if (!existing) return null;

    const timeline = ([...(existing.timeline as { ts: string; who: string; text: string }[] | null) ?? []] as {
      ts: string;
      who: string;
      text: string;
    }[]);
    if (input.timelineEntry) {
      timeline.push({
        ts: new Date().toISOString(),
        who: input.timelineEntry.who,
        text: input.timelineEntry.text,
      });
    }

    let notified = 0;
    if (input.notifyInbox) {
      notified = await this.broadcastIncidentNotice(
        existing.title,
        input.timelineEntry?.text ?? `Incident update: ${existing.title}`,
      );
      timeline.push({
        ts: new Date().toISOString(),
        who: input.timelineEntry?.who ?? (existing.commander || "ops"),
        text: `Status notice posted to consumer inbox (${notified} recipients).`,
      });
    }

    const row = await prisma.adminIncident.update({
      where: { id },
      data: {
        status: input.status ?? existing.status,
        timeline,
      },
    });

    await prisma.adminAuditLog.create({
      data: {
        actor: input.timelineEntry?.who ?? (existing.commander || "ops"),
        action: input.status === "resolved" ? "incident.resolve" : "incident.update",
        subjectId: null,
        detail: `${id}: ${input.timelineEntry?.text ?? input.status ?? "updated"}`,
        meta: { incidentId: id, notified },
      },
    });

    return { ...this.mapIncident(row), notified };
  }

  /** Fan-out inbox notice to recently active customers (capped). */
  async broadcastIncidentNotice(title: string, body: string) {
    const { createInboxMessage } = await import("../../../lib/inbox.js");
    const users = await prisma.user.findMany({
      where: {
        status: { in: ["ACTIVE", "RESTRICTED"] },
        OR: [{ lastActiveAt: { gte: hoursAgo(24 * 30) } }, { createdAt: { gte: hoursAgo(24 * 30) } }],
      },
      select: { id: true },
      take: 500,
      orderBy: { lastActiveAt: "desc" },
    });
    let n = 0;
    for (const u of users) {
      await createInboxMessage({
        userId: u.id,
        title: `Service update: ${title}`.slice(0, 120),
        body: body.slice(0, 2000),
        category: "incident",
      });
      n += 1;
    }
    return n;
  }

  async overviewWork() {
    const [kyc, tickets, closures] = await Promise.all([
      prisma.kycCheck.findMany({
        where: { status: "PENDING" },
        take: 20,
        orderBy: { createdAt: "asc" },
        include: { user: { select: { firstName: true, lastName: true, email: true } } },
      }),
      prisma.supportTicket.findMany({ where: { status: "OPEN" }, take: 20, orderBy: { createdAt: "asc" } }),
      prisma.closureRequest.findMany({ where: { status: "PENDING" }, take: 10, orderBy: { createdAt: "asc" } }),
    ]);
    const items = [
      ...kyc.map((k) => ({
        id: k.id,
        module: "Compliance",
        title: `KYC ${k.type} review — ${displayName(k.user)}`,
        meta: k.status,
        due: k.createdAt.toISOString(),
        priority: "high" as const,
        to: "/admin/compliance",
      })),
      ...tickets.map((t) => ({
        id: t.id,
        module: "Support",
        title: t.topic ?? "Open ticket",
        meta: t.status,
        due: t.createdAt.toISOString(),
        priority: "medium" as const,
        to: "/admin/support",
      })),
      ...closures.map((c) => ({
        id: c.id,
        module: "Platform",
        title: "Closure request",
        meta: c.status,
        due: c.createdAt.toISOString(),
        priority: "high" as const,
        to: "/admin/platform",
      })),
    ];
    return { items };
  }

  private async fxCorridors() {
    const rates = await prisma.fxRate.findMany({ where: { active: true }, take: 8 });
    const swaps = await prisma.swap.groupBy({
      by: ["fromCurrency", "toCurrency"],
      _sum: { fromAmount: true },
      _count: true,
      where: { createdAt: { gte: hoursAgo(24) } },
    });
    const totalVol = swaps.reduce((s, x) => s + Number(x._sum.fromAmount ?? 0), 0) || 1;
    return rates.map((r) => {
      const vol = swaps.find((s) => s.fromCurrency === r.baseCurrency && s.toCurrency === r.quoteCurrency);
      const volume = Number(vol?._sum.fromAmount ?? 0);
      return {
        route: `${r.baseCurrency} → ${r.quoteCurrency}`,
        volume: moneyCompact(volume, r.baseCurrency),
        share: Math.round((volume / totalVol) * 100),
        spread: `${r.baseBps} bps`,
      };
    });
  }

  /* ------------------------------------------------------------------ Customers */

  async listCustomers(query: Record<string, string | undefined>) {
    const page = Math.max(1, Number(query.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit ?? 50)));
    const skip = (page - 1) * limit;
    const where = this.customerWhere(query);

    const [total, users, verified, review, frozen, highRisk] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: this.customerOrder(query.sort, query.dir),
        include: {
          wallets: { where: { isVirtual: false }, select: { currency: true, available: true } },
          virtualAccounts: { take: 1, orderBy: { createdAt: "desc" } },
          _count: { select: { cards: true } },
          referralReceived: true,
        },
      }),
      prisma.user.count({ where: { ...where, kycStatus: "APPROVED" } }),
      prisma.user.count({
        where: { ...where, OR: [{ kycStatus: "PENDING" }, { kycStatus: "NOT_STARTED", kycTier: 0 }] },
      }),
      prisma.user.count({ where: { ...where, status: { in: ["FROZEN", "SUSPENDED", "RESTRICTED"] } } }),
      prisma.user.count({ where: { ...where, riskScore: { gte: 80 } } }),
    ]);

    const customers = users.map((u) => this.toCustomerDto(u));
    const summary = {
      total,
      verified,
      review,
      frozen,
      highRisk,
      sparks: {
        total: sparkFromCounts([total], 1),
        verified: sparkFromCounts([verified], 2),
        review: sparkFromCounts([review], 3),
        highRisk: sparkFromCounts([highRisk], 4),
      },
    };
    return { customers, summary, page, limit, total };
  }

  private customerWhere(query: Record<string, string | undefined>): Prisma.UserWhereInput {
    const where: Prisma.UserWhereInput = {};
    const q = query.q?.trim() || query.search?.trim();
    if (q) {
      where.OR = [
        { email: { contains: q } },
        { phone: { contains: q } },
        { firstName: { contains: q } },
        { lastName: { contains: q } },
        { username: { contains: q } },
        { nin: { contains: q } },
        { bvn: { contains: q } },
        { id: { contains: q } },
      ];
    }
    if (query.tier && query.tier !== "all") where.kycTier = Number(query.tier);
    if (query.status && query.status !== "all") {
      const map: Record<string, UserStatus[]> = {
        active: ["ACTIVE"],
        restricted: ["RESTRICTED"],
        frozen: ["FROZEN", "SUSPENDED"],
        closed: ["CLOSED"],
      };
      where.status = { in: map[query.status] ?? ["ACTIVE"] };
    }
    if (query.kyc && query.kyc !== "all") {
      const map: Record<string, Prisma.UserWhereInput> = {
        unverified: { kycStatus: "NOT_STARTED" },
        nin_pending: { kycStatus: "PENDING", kycTier: 0 },
        verified: { kycStatus: "APPROVED" },
        review: { kycStatus: "PENDING" },
        rejected: { kycStatus: "REJECTED" },
      };
      Object.assign(where, map[query.kyc] ?? {});
    }
    if (query.country && query.country !== "all") where.country = query.country;
    if (query.risk === "low") where.riskScore = { lt: 55 };
    if (query.risk === "medium") where.riskScore = { gte: 55, lt: 80 };
    if (query.risk === "high") where.riskScore = { gte: 80 };
    if (query.source && query.source !== "all") where.signupSource = query.source;
    if (query.active === "24h") where.lastActiveAt = { gte: hoursAgo(24) };
    if (query.active === "7d") where.lastActiveAt = { gte: hoursAgo(24 * 7) };
    if (query.active === "dormant") where.OR = [{ lastActiveAt: null }, { lastActiveAt: { lt: hoursAgo(24 * 30) } }];
    return where;
  }

  private customerOrder(sort?: string, dir?: string): Prisma.UserOrderByWithRelationInput {
    const d = dir === "asc" ? "asc" : "desc";
    switch (sort) {
      case "name":
        return { firstName: d };
      case "risk":
        return { riskScore: d };
      case "ltv":
        return { ltv: d };
      case "active":
        return { lastActiveAt: d };
      case "tier":
        return { kycTier: d };
      default:
        return { createdAt: "desc" };
    }
  }

  private toCustomerDto(u: {
    id: string;
    email: string;
    phone: string | null;
    firstName: string | null;
    lastName: string | null;
    username: string | null;
    nin: string | null;
    bvn: string | null;
    country: string | null;
    kycTier: number;
    kycStatus: string;
    status: UserStatus;
    riskScore: number;
    ltv: { toNumber?: () => number } | number | { [k: string]: unknown };
    signupSource: string | null;
    flagsJson: unknown;
    createdAt: Date;
    lastActiveAt: Date | null;
    wallets?: { currency: WalletCurrency; available: { toNumber?: () => number } | number }[];
    virtualAccounts?: { accountNumber: string }[];
    _count?: { cards: number };
    referralReceived?: unknown;
  }) {
    const balances = { NGN: 0, USD: 0, SAR: 0 };
    for (const w of u.wallets ?? []) {
      if (w.currency === "NGN" || w.currency === "USD" || w.currency === "SAR") {
        balances[w.currency] = Number(w.available);
      }
    }
    const cryptoUsd = (u.wallets ?? [])
      .filter((w) => ["USDT", "BTC", "ETH"].includes(w.currency))
      .reduce((s, w) => {
        const v = Number(w.available);
        if (w.currency === "USDT") return s + v;
        if (w.currency === "BTC") return s + v * 65000;
        if (w.currency === "ETH") return s + v * 3500;
        return s;
      }, 0);

    return {
      id: u.id,
      name: displayName(u),
      username: u.username ?? u.email.split("@")[0],
      phone: u.phone ?? "",
      email: u.email,
      nin: u.nin ?? "",
      bvn: u.bvn ?? "",
      accountNumber: u.virtualAccounts?.[0]?.accountNumber ?? "",
      country: (u.country as "NG" | "SA" | "US") || "NG",
      tier: Math.min(3, Math.max(0, u.kycTier)) as 0 | 1 | 2 | 3,
      status: mapUserStatus(u.status),
      kyc: mapKyc(u.kycStatus, u.kycTier),
      risk: u.riskScore,
      ltv: Number(u.ltv),
      balances,
      cryptoUsd,
      cards: u._count?.cards ?? 0,
      signupSource: (u.signupSource as "organic" | "referral" | "paid" | "campaign") || (u.referralReceived ? "referral" : "organic"),
      createdAt: u.createdAt.toISOString(),
      lastActive: (u.lastActiveAt ?? u.createdAt).toISOString(),
      flags: Array.isArray(u.flagsJson) ? (u.flagsJson as string[]) : [],
    };
  }

  async getCustomer(id: string) {
    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        wallets: true,
        virtualAccounts: true,
        kycChecks: { orderBy: { createdAt: "desc" }, take: 50 },
        beneficiaries: { orderBy: { createdAt: "desc" }, take: 50 },
        refreshTokens: { orderBy: { lastSeenAt: "desc" }, take: 20 },
        supportTickets: {
          orderBy: { updatedAt: "desc" },
          take: 20,
          include: { messages: { orderBy: { createdAt: "desc" }, take: 1 } },
        },
        _count: { select: { cards: true } },
        referralReceived: true,
        referralsSent: {
          take: 20,
          orderBy: { createdAt: "desc" },
          include: {
            referred: { select: { id: true, email: true, firstName: true, lastName: true, createdAt: true } },
          },
        },
      },
    });
    if (!user) return null;

    const transactions = await prisma.transaction.findMany({
      where: { userId: id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const audits = await prisma.adminAuditLog.findMany({
      where: { subjectId: id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    const customer = this.toCustomerDto(user);
    const uaOs = (ua: string | null | undefined) => {
      const s = (ua ?? "").toLowerCase();
      if (/android/.test(s)) return "Android";
      if (/iphone|ipad|ios/.test(s)) return "iOS";
      if (/windows/.test(s)) return "Windows";
      if (/mac os|macintosh/.test(s)) return "macOS";
      if (/linux/.test(s)) return "Linux";
      return "—";
    };
    return {
      customer,
      wallets: user.wallets.map((w) => ({
        id: w.id,
        currency: w.currency,
        available: Number(w.available),
        pending: Number(w.pending),
        isVirtual: w.isVirtual,
      })),
      transactions: transactions.map((t) => ({
        id: t.id,
        at: t.createdAt.toISOString(),
        rail: typeToRail(t.type),
        detail: t.description ?? t.reference,
        amount: moneyFmt(Number(t.amount), t.currency),
        status: mapTxStatus(t.status),
      })),
      devices: user.refreshTokens.map((d) => ({
        id: d.id,
        customerId: id,
        model:
          d.deviceLabel && d.deviceLabel !== "Unknown device"
            ? d.deviceLabel
            : deviceLabelFromUserAgent(d.userAgent ?? undefined),
        os: uaOs(d.userAgent),
        appVersion: "—",
        ip: "—",
        geo: "—",
        lastSeen: d.lastSeenAt.toISOString(),
        trusted: !d.revokedAt,
        sharedWith: 0,
        userAgent: d.userAgent,
        revokedAt: d.revokedAt?.toISOString() ?? null,
      })),
      beneficiaries: user.beneficiaries.map((b) => ({
        id: b.id,
        customerId: id,
        kind: b.type === "CRYPTO" ? "crypto" : "bank",
        label: b.label ?? b.accountName ?? b.type,
        detail: b.accountNumber ?? b.address ?? "",
        network: b.network ?? undefined,
        addedAt: b.createdAt.toISOString(),
        usage: 0,
        screening: b.blockedAt ? ("flagged" as const) : ("clear" as const),
        blocked: Boolean(b.blockedAt),
      })),
      referrals: user.referralsSent.map((r) => {
        const name = [r.referred.firstName, r.referred.lastName].filter(Boolean).join(" ").trim();
        return {
          id: r.id,
          invitee: name || r.referred.email,
          inviteeEmail: r.referred.email,
          joinedAt: r.createdAt.toISOString(),
          activated: r.status === "REWARDED" || r.status === "QUALIFIED",
          payout: Number(r.rewardAmount),
          status: r.status,
          code: r.code,
        };
      }),
      supportTickets: user.supportTickets.map((t) => ({
        id: t.id,
        topic: t.topic,
        status: t.status,
        updatedAt: t.updatedAt.toISOString(),
        lastMessage: t.messages[0]?.body ?? null,
      })),
      kycChecks: user.kycChecks,
      audits: audits.map((a) => ({
        id: a.id,
        at: a.createdAt.toISOString(),
        actor: a.actor,
        action: a.action,
        detail: a.detail,
      })),
      riskSpark: sparkFromCounts([customer.risk], customer.risk || 7),
    };
  }

  async issuePasswordReset(userId: string, actor: string) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
    if (!user) throw new NotFoundError("Customer not found");
    const result = await authService.forgotPassword({ email: user.email });
    // Clear transaction PIN so the customer must set a new one after password recovery.
    await prisma.userSecuritySettings.updateMany({
      where: { userId },
      data: { transactionPinHash: null, transactionPinEnabled: false },
    });
    await prisma.adminAuditLog.create({
      data: {
        actor,
        action: "user.reset_password",
        subjectId: userId,
        detail: `Password reset OTP issued to ${user.email}`,
      },
    });
    return { ok: true, email: user.email, simulated: Boolean((result as { simulated?: boolean }).simulated) };
  }

  async addCustomerNote(userId: string, body: string, actor: string) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundError("Customer not found");
    const note = body.trim();
    if (note.length < 2) throw new AppError("Note is required", 400);

    let ticket = await prisma.supportTicket.findFirst({
      where: { userId, topic: "admin-note", status: "OPEN" },
      orderBy: { updatedAt: "desc" },
    });
    if (!ticket) {
      ticket = await prisma.supportTicket.create({
        data: { userId, topic: "admin-note", status: "OPEN" },
      });
    }
    const message = await prisma.supportMessage.create({
      data: {
        ticketId: ticket.id,
        senderRole: "STAFF",
        body: `[${actor}] ${note}`,
      },
    });
    await prisma.supportTicket.update({ where: { id: ticket.id }, data: { updatedAt: new Date() } });
    await prisma.adminAuditLog.create({
      data: { actor, action: "user.note", subjectId: userId, detail: note.slice(0, 500) },
    });
    return {
      ticket: {
        id: ticket.id,
        topic: ticket.topic,
        status: ticket.status,
        updatedAt: new Date().toISOString(),
        lastMessage: message.body,
      },
    };
  }

  async previewSegment(rules: unknown) {
    const query = this.rulesToCustomerQuery(rules);
    const where = this.customerWhere(query);
    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        take: 25,
        orderBy: { lastActiveAt: "desc" },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          country: true,
          kycTier: true,
          status: true,
          riskScore: true,
        },
      }),
    ]);
    return {
      total,
      customers: users.map((u) => ({
        id: u.id,
        email: u.email,
        name: [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email,
        country: u.country ?? "—",
        tier: u.kycTier,
        status: mapUserStatus(u.status),
        risk: u.riskScore,
      })),
    };
  }

  private rulesToCustomerQuery(rules: unknown): Record<string, string | undefined> {
    const query: Record<string, string | undefined> = {};
    const list = Array.isArray(rules) ? rules : [];
    for (const raw of list) {
      if (typeof raw === "string") {
        const m = raw.match(/^(\S+)\s+(=|≠|≥|≤|>=|<=|>|<|contains|in last)\s+(.+)$/);
        if (!m) continue;
        this.applySegmentRule(query, m[1]!, m[2]!, m[3]!.trim());
        continue;
      }
      if (raw && typeof raw === "object") {
        const r = raw as { attr?: string; field?: string; op?: string; value?: string };
        const attr = r.attr ?? r.field;
        const op = r.op ?? "=";
        const value = r.value;
        if (attr && value != null && String(value).length) this.applySegmentRule(query, attr, op, String(value));
      }
    }
    return query;
  }

  private applySegmentRule(
    query: Record<string, string | undefined>,
    attr: string,
    op: string,
    value: string,
  ) {
    if (attr === "country") query.country = value;
    else if (attr === "tier") query.tier = value;
    else if (attr === "status") query.status = value.toLowerCase();
    else if (attr === "kyc") query.kyc = value.toLowerCase();
    else if (attr === "signup_source") query.source = value.toLowerCase();
    else if (attr === "risk_score") {
      const n = Number(value);
      if (!Number.isFinite(n)) return;
      if (op === "≥" || op === ">=" || op === ">") query.risk = n >= 80 ? "high" : n >= 55 ? "medium" : "low";
      else if (op === "≤" || op === "<=" || op === "<") query.risk = n < 55 ? "low" : n < 80 ? "medium" : "high";
      else query.risk = n >= 80 ? "high" : n >= 55 ? "medium" : "low";
    } else if (attr === "last_active_at" || attr === "last_active") {
      if (/24h|1d/i.test(value)) query.active = "24h";
      else if (/7d|week/i.test(value)) query.active = "7d";
      else if (/dormant|30d|inactive/i.test(value)) query.active = "dormant";
    }
  }

  async setUserStatus(id: string, status: UserStatus, actor: string) {
    const user = await prisma.user.update({ where: { id }, data: { status } });
    await prisma.adminAuditLog.create({
      data: { actor, action: `user.status.${status}`, subjectId: id, detail: `Status set to ${status}` },
    });
    return user;
  }

  async setUserTier(id: string, tier: number, actor: string) {
    const user = await prisma.user.update({
      where: { id },
      data: { kycTier: Math.min(3, Math.max(0, tier)), kycStatus: tier > 0 ? "APPROVED" : undefined },
    });
    await prisma.adminAuditLog.create({
      data: { actor, action: "user.tier", subjectId: id, detail: `Tier set to ${tier}` },
    });
    return user;
  }

  /* ------------------------------------------------------------------ Money */

  async listMoneyTransactions(query: Record<string, string | undefined>) {
    const page = Math.max(1, Number(query.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit ?? 50)));
    const skip = (page - 1) * limit;
    const where = this.txWhere(query);

    const [total, items] = await Promise.all([
      prisma.transaction.count({ where }),
      prisma.transaction.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
      }),
    ]);

    const allForSummary = await prisma.transaction.findMany({
      where,
      select: { type: true, status: true, amount: true, fee: true, currency: true },
      take: 2000,
    });

    const toNgn = (amount: number, currency: string) =>
      currency === "NGN" ? amount : currency === "USD" ? amount * 1642 : amount * 438;

    let inflow = 0;
    let outflow = 0;
    let fees = 0;
    let failed = 0;
    let pending = 0;
    for (const t of allForSummary) {
      const amt = toNgn(Number(t.amount), t.currency);
      const fee = toNgn(Number(t.fee), t.currency);
      fees += fee;
      const dir = typeToDirection(t.type);
      if (dir === "in") inflow += amt;
      if (dir === "out") outflow += amt;
      if (t.status === "FAILED" || t.status === "REVERSED") failed += 1;
      if (t.status === "PENDING" || t.status === "PROCESSING") pending += 1;
    }

    const transactions = items.map((t) => ({
      id: t.id,
      at: t.createdAt.toISOString(),
      rail: typeToRail(t.type),
      direction: typeToDirection(t.type),
      currency: t.currency === "USDT" || t.currency === "BTC" || t.currency === "ETH" ? "USD" : t.currency,
      amount: Number(t.amount),
      fee: Number(t.fee),
      status: mapTxStatus(t.status),
      customerId: t.userId,
      customerName: displayName(t.user),
      customerEmail: t.user.email,
      counterparty: t.description ?? t.reference,
      provider: t.provider ?? "fulus",
      providerRef: t.providerRef ?? t.reference,
      latencyMs: 0,
      riskDecision: "approved" as const,
      ip: "—",
      deviceId: "—",
      failureReason: t.status === "FAILED" ? "Provider or policy failure" : undefined,
    }));

    return {
      transactions,
      summary: {
        inflow,
        outflow,
        failed,
        pending,
        fees,
        sparks: {
          inflow: sparkFromCounts([inflow], 21),
          outflow: sparkFromCounts([outflow], 22),
          failed: sparkFromCounts([failed], 23),
          fees: sparkFromCounts([fees], 24),
        },
      },
      page,
      limit,
      total,
    };
  }

  private txWhere(query: Record<string, string | undefined>): Prisma.TransactionWhereInput {
    const where: Prisma.TransactionWhereInput = {};
    if (query.userId) where.userId = query.userId;
    if (query.q) {
      const q = query.q.trim();
      where.OR = [
        { reference: { contains: q } },
        { description: { contains: q } },
        { providerRef: { contains: q } },
        { provider: { contains: q } },
        { id: { contains: q } },
        { user: { email: { contains: q } } },
        { user: { firstName: { contains: q } } },
        { user: { lastName: { contains: q } } },
      ];
    }
    if (query.provider && query.provider !== "all") {
      where.provider = { contains: query.provider };
    }
    if (query.currency && query.currency !== "all") {
      where.currency = query.currency as WalletCurrency;
    }
    if (query.status && query.status !== "all") {
      const map: Record<string, TransactionStatus[]> = {
        settled: ["SUCCESS"],
        pending: ["PENDING"],
        authorised: ["PROCESSING"],
        failed: ["FAILED"],
        reversed: ["REVERSED"],
      };
      where.status = { in: map[query.status] ?? ["SUCCESS"] };
    }
    if (query.rail && query.rail !== "all") {
      const reverse: Record<string, TransactionType[]> = {
        bank_payout: ["WITHDRAWAL"],
        virtual_account: ["DEPOSIT"],
        card: ["CARD_FUND", "CARD_WITHDRAW"],
        crypto: ["CRYPTO_BUY", "CRYPTO_SELL", "CRYPTO_SEND", "CRYPTO_RECEIVE"],
        bill: ["BILL_PAYMENT"],
        esim: ["ESIM_PURCHASE"],
        internal: ["TRANSFER", "FEE", "ADJUSTMENT"],
        swap: ["SWAP"],
      };
      where.type = { in: reverse[query.rail] ?? [] };
    }
    if (query.direction === "in") where.type = { in: ["DEPOSIT", "CRYPTO_RECEIVE", "CARD_WITHDRAW"] };
    if (query.direction === "out")
      where.type = { in: ["WITHDRAWAL", "BILL_PAYMENT", "CRYPTO_SEND", "ESIM_PURCHASE", "CARD_FUND"] };
    if (query.direction === "internal") where.type = { in: ["TRANSFER", "SWAP", "FEE", "ADJUSTMENT"] };
    if (query.window === "1h") where.createdAt = { gte: hoursAgo(1) };
    if (query.window === "24h") where.createdAt = { gte: hoursAgo(24) };
    if (query.window === "7d") where.createdAt = { gte: hoursAgo(24 * 7) };
    return where;
  }

  async getMoneyTransaction(id: string) {
    const tx = await prisma.transaction.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
        ledgerEntries: {
          orderBy: { createdAt: "asc" },
          include: { wallet: { select: { currency: true } } },
        },
      },
    });
    if (!tx) return null;
    const moneyTx = {
      id: tx.id,
      at: tx.createdAt.toISOString(),
      rail: typeToRail(tx.type),
      direction: typeToDirection(tx.type),
      currency: tx.currency,
      amount: Number(tx.amount),
      fee: Number(tx.fee),
      status: mapTxStatus(tx.status),
      customerId: tx.userId,
      customerName: displayName(tx.user),
      customerEmail: tx.user.email,
      counterparty: tx.description ?? tx.reference,
      provider: tx.provider ?? "fulus",
      providerRef: tx.providerRef ?? tx.reference,
      latencyMs: 0,
      riskDecision: "approved" as const,
      ip: "—",
      deviceId: "—",
    };
    const ledger = tx.ledgerEntries.map((e) => ({
      account: e.walletId,
      type: e.type === "CREDIT" ? "liability" : "asset",
      debit: e.type === "DEBIT" ? Number(e.amount) : 0,
      credit: e.type === "CREDIT" ? Number(e.amount) : 0,
      currency: e.wallet.currency,
    }));
    const timeline = [
      { ts: tx.createdAt.toISOString(), label: "Created", detail: tx.reference },
      { ts: tx.updatedAt.toISOString(), label: tx.status, detail: tx.provider ?? "core" },
    ];
    return {
      transaction: moneyTx,
      ledger,
      timeline,
      providerPayload: tx.metadata ?? { reference: tx.reference, provider: tx.provider, providerRef: tx.providerRef },
    };
  }

  async listCardPayments(query: Record<string, string | undefined>) {
    const page = Math.max(1, Number(query.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit ?? 25)));
    const skip = (page - 1) * limit;
    const where: Prisma.DepositWhereInput = { method: "CARD" };
    if (query.status && query.status !== "all") {
      const map: Record<string, TransactionStatus[]> = {
        successful: ["SUCCESS"],
        pending_3ds: ["PROCESSING", "PENDING"],
        failed: ["FAILED"],
        reversed: ["REVERSED"],
        flagged: ["PENDING"],
      };
      where.status = { in: map[query.status] ?? ["SUCCESS"] };
    }
    if (query.wallet && query.wallet !== "all") where.currency = query.wallet as WalletCurrency;
    if (query.q) {
      const q = query.q.trim();
      where.OR = [
        { id: { contains: q } },
        { providerRef: { contains: q } },
        { user: { email: { contains: q } } },
        { user: { firstName: { contains: q } } },
        { user: { lastName: { contains: q } } },
      ];
    }
    const [total, items] = await Promise.all([
      prisma.deposit.count({ where }),
      prisma.deposit.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
      }),
    ]);
    const payments = items.map((d) => {
      const amount = Number(d.amount ?? 0);
      const fee = amount * 0.015;
      const statusMap: Record<string, string> = {
        SUCCESS: "successful",
        PENDING: "pending_3ds",
        PROCESSING: "pending_3ds",
        FAILED: "failed",
        REVERSED: "reversed",
      };
      return {
        id: d.id,
        at: d.createdAt.toISOString(),
        customer: displayName(d.user),
        customerId: d.userId,
        customerEmail: d.user.email,
        cardCur: d.currency,
        wallet: d.currency === "USDT" ? "USD" : d.currency,
        charged: amount,
        fee,
        credited: amount - fee,
        rate: 1,
        brand: "CARD",
        last4: "••••",
        issuerCountry: "NG",
        status: statusMap[d.status] ?? "pending_3ds",
        flwRef: d.providerRef ?? d.id,
      };
    });
    const summaryWhere: Prisma.DepositWhereInput = { method: "CARD" };
    const [successful, failed, pending] = await Promise.all([
      prisma.deposit.count({ where: { ...summaryWhere, status: "SUCCESS" } }),
      prisma.deposit.count({ where: { ...summaryWhere, status: "FAILED" } }),
      prisma.deposit.count({ where: { ...summaryWhere, status: { in: ["PENDING", "PROCESSING"] } } }),
    ]);
    const ok = payments.filter((p) => p.status === "successful");
    return {
      payments,
      summary: {
        successful,
        volume: ok.reduce((s, p) => s + p.charged, 0),
        flagged: pending,
        failed,
        sparks: {
          successful: sparkFromCounts([successful], 81),
          volume: sparkFromCounts([ok.reduce((s, p) => s + p.charged, 0)], 82),
          flagged: sparkFromCounts([pending], 83),
          failed: sparkFromCounts([failed], 84),
        },
      },
      page,
      limit,
      total,
    };
  }

  async settleTransaction(id: string, actor: string) {
    const tx = await prisma.transaction.findUnique({
      where: { id },
      include: { deposit: true },
    });
    if (!tx) throw new NotFoundError("Transaction not found");
    if (tx.status === "SUCCESS") return { transaction: tx, alreadySettled: true };

    if (tx.deposit && (tx.deposit.status === "PENDING" || tx.deposit.status === "PROCESSING")) {
      const { depositsService } = await import("../../deposits/services/deposits.service.js");
      await depositsService.confirm(tx.deposit.id);
      await prisma.adminAuditLog.create({
        data: {
          actor,
          action: "transaction.manual_settle",
          subjectId: id,
          detail: `Settled via deposit confirm (${tx.deposit.id})`,
        },
      });
      const refreshed = await prisma.transaction.findUnique({ where: { id } });
      return { transaction: refreshed, alreadySettled: false };
    }

    if (tx.status !== "PENDING" && tx.status !== "PROCESSING") {
      throw new AppError(`Cannot settle transaction in status ${tx.status}`, 400);
    }

    const updated = await prisma.transaction.update({
      where: { id },
      data: { status: "SUCCESS" },
    });
    await prisma.adminAuditLog.create({
      data: {
        actor,
        action: "transaction.manual_settle",
        subjectId: id,
        detail: `Forced status PENDING/PROCESSING → SUCCESS`,
      },
    });
    return { transaction: updated, alreadySettled: false };
  }

  async refundCardPayment(depositId: string, actor: string, note?: string) {
    const deposit = await prisma.deposit.findUnique({ where: { id: depositId } });
    if (!deposit) throw new NotFoundError("Card payment not found");
    if (deposit.method !== "CARD") throw new AppError("Not a card payment", 400);
    if (deposit.status !== "SUCCESS") throw new AppError("Only successful card payments can be refunded", 400);

    const amount = Number(deposit.amount ?? 0);
    if (!(amount > 0)) throw new AppError("Invalid payment amount", 400);

    const { walletService } = await import("../../wallet/services/wallet.service.js");
    const debitTx = await walletService.debit({
      userId: deposit.userId,
      currency: deposit.currency,
      amount,
      type: "ADJUSTMENT",
      description: `Card payment refund ${deposit.id}`,
      provider: deposit.provider ?? "flutterwave",
      providerRef: deposit.providerRef ?? undefined,
      metadata: { refundOfDepositId: deposit.id, admin: actor },
    });

    await prisma.deposit.update({
      where: { id: depositId },
      data: { status: "REVERSED" },
    });

    const refund = await prisma.refund.create({
      data: {
        userId: deposit.userId,
        transactionId: debitTx.id,
        status: "processing",
        origin: "admin",
        reason: note?.trim() || "Admin refund to card",
        rail: "card",
        method: "original_card",
        originalAmount: amount,
        amount,
        currency: deposit.currency,
        requestedBy: actor,
        provider: deposit.provider ?? "flutterwave",
        providerRef: deposit.providerRef,
        note: note?.trim() || null,
      },
    });

    await prisma.adminAuditLog.create({
      data: {
        actor,
        action: "refund.card_deposit",
        subjectId: depositId,
        detail: `Refund ${amount} ${deposit.currency} to card (wallet debited)`,
      },
    });

    return { refund, depositId, transactionId: debitTx.id };
  }

  async listDisputes(query: Record<string, string | undefined>) {
    const where: Prisma.DisputeWhereInput = {};
    if (query.stage && query.stage !== "all") where.stage = query.stage;
    if (query.rail && query.rail !== "all") where.rail = query.rail;
    if (query.reason && query.reason !== "all") where.reasonCode = query.reason;
    if (query.owner && query.owner !== "all") where.owner = query.owner;
    if (query.q) {
      where.OR = [
        { caseRef: { contains: query.q } },
        { merchant: { contains: query.q } },
        { id: { contains: query.q } },
      ];
    }
    const items = await prisma.dispute.findMany({
      where,
      orderBy: { openedAt: "desc" },
      take: 100,
      include: { user: { select: { firstName: true, lastName: true, email: true } } },
    });
    const disputes = items.map((d) => ({
      id: d.id,
      caseRef: d.caseRef,
      openedAt: d.openedAt.toISOString(),
      deadlineAt: (d.deadlineAt ?? d.openedAt).toISOString(),
      stage: d.stage,
      rail: d.rail,
      reason: { code: d.reasonCode, label: d.reasonLabel, rail: d.rail, network: d.network },
      amount: Number(d.amount),
      currency: d.currency,
      feeNgn: Number(d.feeNgn),
      provisionalCredit: d.provisionalCredit,
      liability: d.liability,
      customerId: d.userId,
      customerName: displayName(d.user),
      customerEmail: d.user.email,
      txId: d.transactionId ?? "",
      merchant: d.merchant,
      network: d.network,
      owner: d.owner,
      priority: d.priority,
      evidence: d.evidence ?? [],
      timeline: d.timeline ?? [],
      winProbability: d.winProbability,
      notes: d.notes ?? "",
    }));
    return {
      disputes,
      summary: {
        open: disputes.filter((d) => !["won", "lost", "refunded", "withdrawn"].includes(d.stage)).length,
        sparks: sparkFromCounts([disputes.length], 91),
      },
    };
  }

  async listRefunds(query: Record<string, string | undefined>) {
    const where: Prisma.RefundWhereInput = {};
    if (query.status && query.status !== "all") where.status = query.status;
    if (query.rail && query.rail !== "all") where.rail = query.rail;
    if (query.origin && query.origin !== "all") where.origin = query.origin;
    if (query.method && query.method !== "all") where.method = query.method;
    if (query.q) {
      where.OR = [{ id: { contains: query.q } }, { transactionId: { contains: query.q } }, { reason: { contains: query.q } }];
    }
    const items = await prisma.refund.findMany({
      where,
      orderBy: { requestedAt: "desc" },
      take: 100,
      include: { user: { select: { firstName: true, lastName: true, email: true } } },
    });
    const refunds = items.map((r) => ({
      id: r.id,
      txId: r.transactionId ?? "",
      disputeId: r.disputeId ?? undefined,
      requestedAt: r.requestedAt.toISOString(),
      dueAt: (r.dueAt ?? r.requestedAt).toISOString(),
      completedAt: r.completedAt?.toISOString(),
      status: r.status,
      origin: r.origin,
      reason: r.reason,
      rail: r.rail,
      method: r.method,
      originalAmount: Number(r.originalAmount),
      amount: Number(r.amount),
      feeRefunded: Number(r.feeRefunded),
      currency: r.currency,
      partial: r.partial,
      customerId: r.userId,
      customerName: displayName(r.user),
      customerEmail: r.user.email,
      requestedBy: r.requestedBy,
      approver: r.approver ?? undefined,
      provider: r.provider,
      providerRef: r.providerRef ?? "",
      autoApproved: r.autoApproved,
      recoverable: r.recoverable,
      recoveredFrom: r.recoveredFrom ?? undefined,
      slaHours: r.slaHours,
      timeline: r.timeline ?? [],
      note: r.note ?? "",
      failureReason: r.failureReason ?? undefined,
    }));
    return {
      refunds,
      summary: {
        queue: refunds.filter((r) => ["requested", "awaiting_approval", "approved", "processing"].includes(r.status)).length,
        sparks: sparkFromCounts([refunds.length], 92),
      },
    };
  }

  async listSegments() {
    const items = await prisma.customerSegment.findMany({ orderBy: { updatedAt: "desc" } });
    return {
      segments: items.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        size: s.sizeCache,
        rules: Array.isArray(s.rules) ? (s.rules as string[]) : [],
        owner: s.owner,
        updatedAt: s.updatedAt.toISOString(),
        usedBy: Array.isArray(s.usedBy) ? (s.usedBy as string[]) : [],
      })),
    };
  }

  async createSegment(input: { name: string; description: string; rules: unknown; owner: string }) {
    const preview = await this.previewSegment(input.rules);
    return prisma.customerSegment.create({
      data: {
        name: input.name,
        description: input.description,
        rules: input.rules as Prisma.InputJsonValue,
        owner: input.owner,
        sizeCache: preview.total,
        usedBy: [],
      },
    });
  }

  async setBeneficiaryBlocked(id: string, blocked: boolean, actor: string) {
    const existing = await prisma.beneficiary.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Beneficiary not found");
    const updated = await prisma.beneficiary.update({
      where: { id },
      data: blocked
        ? { blockedAt: new Date(), blockedBy: actor }
        : { blockedAt: null, blockedBy: null },
    });
    await prisma.adminAuditLog.create({
      data: {
        actor,
        action: blocked ? "beneficiary.block" : "beneficiary.unblock",
        subjectId: existing.userId,
        detail: `${blocked ? "Blocked" : "Unblocked"} beneficiary ${existing.label} (${id})`,
      },
    });
    return {
      id: updated.id,
      blocked: Boolean(updated.blockedAt),
      blockedAt: updated.blockedAt?.toISOString() ?? null,
    };
  }

  async listStatementLines() {
    const lines = await prisma.bankStatementLine.findMany({ orderBy: { at: "desc" }, take: 100 });
    return {
      lines: lines.map((l) => ({
        id: l.id,
        at: l.at.toISOString(),
        bank: l.bank,
        narration: l.narration,
        amount: Number(l.amount),
        currency: l.currency,
        matched: l.matched,
        matchedDepositId: l.matchedDepositId ?? undefined,
        suggestion: l.suggestion ?? undefined,
      })),
    };
  }

  async listPayoutBatches() {
    const batches = await prisma.payoutBatch.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
    return {
      batches: batches.map((b) => ({
        id: b.id,
        createdAt: b.createdAt.toISOString(),
        createdBy: b.createdBy,
        rail: b.rail,
        currency: b.currency,
        count: b.count,
        total: Number(b.total),
        succeeded: b.succeeded,
        failed: b.failed,
        status: b.status,
        approver: b.approver ?? undefined,
      })),
    };
  }
}

export const adminConsoleService = new AdminConsoleService();
