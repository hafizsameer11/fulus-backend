import { prisma } from "../../../lib/prisma.js";
import { floatJobsService } from "../../float/services/float-jobs.service.js";

async function getConfig<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma.platformConfig.findUnique({ where: { key } });
  if (!row?.value) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

async function putConfig<T>(key: string, value: T): Promise<T> {
  const raw = JSON.stringify(value);
  await prisma.platformConfig.upsert({
    where: { key },
    create: { key, value: raw },
    update: { value: raw },
  });
  return value;
}

export type CloseStep = { id: string; label: string; detail: string; done: boolean };

export type DeskInvoice = {
  id: string;
  counterparty: string;
  direction: "payable" | "receivable";
  category: string;
  currency: string;
  amount: number;
  paid: number;
  issued: string;
  due: string;
  status: "draft" | "sent" | "part_paid" | "paid" | "overdue" | "disputed";
  poRef: string;
  owner: string;
  lines: { label: string; qty: number; unit: number }[];
};

const DEFAULT_INVOICES: DeskInvoice[] = [
  {
    id: "INV-2026-PAGO",
    counterparty: "Pagocards",
    direction: "payable",
    category: "Card processing",
    currency: "USD",
    amount: 2400,
    paid: 0,
    issued: new Date(Date.now() - 12 * 86400000).toISOString().slice(0, 10),
    due: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
    status: "sent",
    poRef: "PO-CARD-01",
    owner: "Finance",
    lines: [{ label: "Issuance + auth fees", qty: 1, unit: 2400 }],
  },
  {
    id: "INV-2026-BUSHA",
    counterparty: "Busha",
    direction: "payable",
    category: "Crypto / FX",
    currency: "NGN",
    amount: 1_850_000,
    paid: 0,
    issued: new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 10),
    due: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
    status: "sent",
    poRef: "PO-CRYPTO-01",
    owner: "Finance",
    lines: [{ label: "Spread settlement", qty: 1, unit: 1_850_000 }],
  },
  {
    id: "INV-2026-STRO",
    counterparty: "Strowallet",
    direction: "payable",
    category: "Bill aggregation",
    currency: "NGN",
    amount: 920_000,
    paid: 420_000,
    issued: new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10),
    due: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10),
    status: "overdue",
    poRef: "PO-BILL-01",
    owner: "Finance",
    lines: [{ label: "Vend commission net", qty: 1, unit: 920_000 }],
  },
  {
    id: "INV-2026-ESIM",
    counterparty: "eSIM Go",
    direction: "payable",
    category: "eSIM wholesale",
    currency: "USD",
    amount: 6400,
    paid: 6400,
    issued: new Date(Date.now() - 35 * 86400000).toISOString().slice(0, 10),
    due: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10),
    status: "paid",
    poRef: "PO-ESIM-01",
    owner: "Finance",
    lines: [{ label: "Profile pool top-up", qty: 1, unit: 6400 }],
  },
];

const DEFAULT_REFERRAL_CONFIG = {
  referrerReward: 1000,
  inviteeReward: 500,
  qualification: "Invitee completes NIN and first deposit of at least 2,000 naira",
  holdDays: 7,
  monthlyBudget: 12_000_000,
  perUserCap: 25,
  fraudRules: [
    { id: "FR-1", label: "Same device fingerprint as referrer", action: "hold", hits: 0, on: true },
    { id: "FR-2", label: "Funding source shared with referrer", action: "hold", hits: 0, on: true },
    { id: "FR-3", label: "More than 5 signups per IP in 24h", action: "reject", hits: 0, on: true },
    { id: "FR-4", label: "Invitee closes account within 14 days", action: "claw back", hits: 0, on: false },
  ],
};

function daysBetween(iso: string) {
  const due = Date.parse(iso);
  if (!Number.isFinite(due)) return 999;
  return Math.ceil((due - Date.now()) / 86400000);
}

function lagLabel(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function pipelineStatus(ms: number): "fresh" | "lagging" | "stale" {
  if (!Number.isFinite(ms)) return "stale";
  if (ms <= 5 * 60_000) return "fresh";
  if (ms <= 60 * 60_000) return "lagging";
  return "stale";
}

function compactCount(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Hint threshold before suggesting a customer→master Busha sweep. */
const SWEEP_HINT_NGN = 25_000;

function mean(xs: number[]) {
  if (!xs.length) return 0;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

function stdev(xs: number[]) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

export class AdminDeskService {
  async dayClose() {
    const [recon, fxActive, statementTotal, statementMatched, feeRows, overrides] = await Promise.all([
      floatJobsService.reconcile(),
      prisma.fxRate.count({ where: { active: true } }),
      prisma.bankStatementLine.count(),
      prisma.bankStatementLine.count({ where: { matched: true } }),
      prisma.transaction.aggregate({
        where: {
          status: "SUCCESS",
          createdAt: { gte: new Date(new Date().toISOString().slice(0, 10)) },
          fee: { gt: 0 },
        },
        _sum: { fee: true },
        _count: true,
      }),
      getConfig<Record<string, boolean>>("finance.day_close_overrides", {}),
    ]);

    const matchPct =
      statementTotal > 0 ? Math.round((statementMatched / statementTotal) * 10000) / 100 : 100;
    const coverageOk = recon.healthy !== false && Number(recon.shortfall ?? 0) <= 0;
    const openBreaks = Math.max(0, statementTotal - statementMatched);
    const feePosted = Number(feeRows._count ?? 0) > 0;

    const computed: CloseStep[] = [
      {
        id: "statements",
        label: "Provider statements ingested",
        detail:
          statementTotal > 0
            ? `${statementMatched} of ${statementTotal} statement lines matched`
            : "No bank statement lines yet today",
        done: statementTotal > 0,
      },
      {
        id: "matching",
        label: "Automated matching complete",
        detail: `${matchPct}% matched on last run`,
        done: statementTotal === 0 || matchPct >= 99,
      },
      {
        id: "fx_mark",
        label: "FX positions marked to close",
        detail: `${fxActive} active corridor${fxActive === 1 ? "" : "s"} published`,
        done: fxActive > 0,
      },
      {
        id: "coverage",
        label: "Cash coverage attested",
        detail: coverageOk
          ? "Float healthy vs customer liabilities"
          : `Shortfall ₦${Math.round(Number(recon.shortfall ?? 0)).toLocaleString()}`,
        done: coverageOk,
      },
      {
        id: "breaks",
        label: "Breaks under 7 days cleared",
        detail:
          openBreaks === 0
            ? "No open statement breaks"
            : `${openBreaks} unmatched statement line${openBreaks === 1 ? "" : "s"}`,
        done: openBreaks === 0,
      },
      {
        id: "revenue",
        label: "Revenue journals posted",
        detail: feePosted
          ? `${feeRows._count} fee-bearing txs booked today · ₦${Math.round(Number(feeRows._sum.fee ?? 0)).toLocaleString()}`
          : "Awaiting fee-bearing settlements today",
        done: feePosted,
      },
    ];

    const steps = computed.map((s) =>
      Object.prototype.hasOwnProperty.call(overrides, s.id) ? { ...s, done: Boolean(overrides[s.id]) } : s,
    );

    return {
      at: new Date().toISOString(),
      done: steps.filter((s) => s.done).length,
      total: steps.length,
      steps,
    };
  }

  async putDayCloseOverrides(body: Record<string, boolean>) {
    const next = await putConfig("finance.day_close_overrides", body ?? {});
    return { overrides: next, ...(await this.dayClose()) };
  }

  async listInvoices() {
    const stored = await getConfig<DeskInvoice[] | null>("finance.invoices", null);
    if (!stored?.length) {
      await putConfig("finance.invoices", DEFAULT_INVOICES);
      return this.invoicePayload(DEFAULT_INVOICES);
    }
    // Refresh overdue flags from due dates
    const refreshed = stored.map((inv) => {
      if (inv.status === "paid" || inv.status === "draft" || inv.status === "disputed") return inv;
      const d = daysBetween(inv.due);
      if (d < 0 && inv.status !== "overdue") return { ...inv, status: "overdue" as const };
      return inv;
    });
    if (JSON.stringify(refreshed) !== JSON.stringify(stored)) {
      await putConfig("finance.invoices", refreshed);
    }
    return this.invoicePayload(refreshed);
  }

  async putInvoices(invoices: DeskInvoice[]) {
    const list = Array.isArray(invoices) ? invoices : [];
    await putConfig("finance.invoices", list);
    return this.invoicePayload(list);
  }

  private invoicePayload(invoices: DeskInvoice[]) {
    const dueSoon = invoices.filter((i) => i.status !== "paid" && daysBetween(i.due) < 7).length;
    const overdue = invoices.filter((i) => i.status === "overdue").length;
    const outstanding = invoices
      .filter((i) => i.status !== "paid" && i.status !== "draft")
      .reduce((s, i) => s + Math.max(0, Number(i.amount) - Number(i.paid)), 0);
    return { invoices, dueSoon, overdue, outstanding };
  }

  async analyticsAnomalies() {
    const keys = [
      { key: "bill_orders", title: "Bill orders vs 14d baseline", metric: "bill_orders" },
      { key: "signups", title: "Signups vs 14d baseline", metric: "signups" },
      { key: "arpu", title: "ARPU vs 14d baseline", metric: "arpu" },
      { key: "esim_orders", title: "eSIM orders vs 14d baseline", metric: "esim_orders" },
      { key: "tpv_ngn", title: "TPV vs 14d baseline", metric: "tpv_ngn" },
      { key: "revenue_ngn", title: "Revenue vs 14d baseline", metric: "revenue_ngn" },
    ] as const;

    const { adminModulesService } = await import("./admin-modules.service.js");
    const subs = await getConfig<Record<string, boolean>>("analytics.anomaly_subs", {});
    const anomalies = [];

    for (const meta of keys) {
      const series = await adminModulesService.metricSeries(meta.key, 21);
      const vals = series.map((p) => Number(p.v) || 0);
      if (vals.length < 8) continue;
      const recent = vals.slice(-3);
      const baseline = vals.slice(0, -3);
      const observed = mean(recent);
      const expected = mean(baseline);
      const sd = stdev(baseline) || 1;
      const sigma = Math.abs(observed - expected) / sd;
      if (sigma < 2) continue;
      const pct = expected ? ((observed - expected) / expected) * 100 : 0;
      anomalies.push({
        id: `an-${meta.key}`,
        metric: meta.metric,
        title: `${meta.title.split(" vs")[0]} ${pct >= 0 ? "above" : "below"} forecast`,
        detail: `Last 3d mean ${Math.round(observed).toLocaleString()} vs baseline ${Math.round(expected).toLocaleString()} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%).`,
        observed: String(Math.round(observed).toLocaleString()),
        expected: String(Math.round(expected).toLocaleString()),
        sigma: Math.round(sigma * 10) / 10,
        at: new Date().toISOString(),
        subscribed: subs[meta.key] ?? true,
        severity: sigma >= 3.5 ? "critical" : sigma >= 2.5 ? "warning" : "info",
      });
    }

    if (!anomalies.length) {
      anomalies.push({
        id: "an-ok",
        metric: "tpv_ngn",
        title: "All watched metrics within 2σ",
        detail: "No significant deviations from the trailing baseline.",
        observed: "—",
        expected: "—",
        sigma: 0,
        at: new Date().toISOString(),
        subscribed: true,
        severity: "info" as const,
      });
    }

    return { anomalies };
  }

  async putAnomalySubs(subs: Record<string, boolean>) {
    const current = await getConfig<Record<string, boolean>>("analytics.anomaly_subs", {});
    const merged = { ...current };
    for (const [k, v] of Object.entries(subs ?? {})) {
      const key = k.startsWith("an-") ? k.slice(3) : k;
      if (key === "ok") continue;
      merged[key] = Boolean(v);
    }
    await putConfig("analytics.anomaly_subs", merged);
    return this.analyticsAnomalies();
  }

  async analyticsExports() {
    const stored = await getConfig<unknown[] | null>("analytics.export_log", null);
    if (stored?.length) return { exports: stored };

    // Seed from recent admin audit export-ish actions if present
    const audits = await prisma.adminAuditLog.findMany({
      where: { action: { contains: "export" } },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    const seeded =
      audits.length > 0
        ? audits.map((a, i) => ({
            id: `EXP-${String(4400 + i)}`,
            what: a.detail || a.action,
            by: a.actor,
            at: a.createdAt.toISOString(),
            rows: 0,
            format: "CSV" as const,
            watermark: `FULUS·${a.actor.slice(0, 2).toUpperCase()}·${4400 + i}`,
          }))
        : [];
    if (seeded.length) await putConfig("analytics.export_log", seeded);
    return { exports: seeded };
  }

  async recordAnalyticsExport(body: {
    what?: string;
    by?: string;
    rows?: number;
    format?: "CSV" | "XLSX" | "PDF";
  }) {
    const current = (await this.analyticsExports()).exports as Array<Record<string, unknown>>;
    const id = `EXP-${Date.now().toString().slice(-6)}`;
    const row = {
      id,
      what: body.what || "Manual export",
      by: body.by || "Admin",
      at: new Date().toISOString(),
      rows: Number(body.rows ?? 0),
      format: body.format || "CSV",
      watermark: `FULUS·${(body.by || "AD").slice(0, 2).toUpperCase()}·${id.slice(-4)}`,
    };
    const next = [row, ...current].slice(0, 50);
    await putConfig("analytics.export_log", next);
    return { export: row, exports: next };
  }

  async analyticsPipelines() {
    const now = Date.now();
    const sources: {
      name: string;
      source: string;
      latest: Date | null;
      count: number;
    }[] = [];

    const [txLatest, txCount, userLatest, userCount, authLatest, authCount, fxLatest, fxCount, billLatest, billCount, hookLatest, hookCount] =
      await Promise.all([
        prisma.transaction.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
        prisma.transaction.count(),
        prisma.user.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
        prisma.user.count(),
        prisma.cardAuthorization.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
        prisma.cardAuthorization.count(),
        prisma.fxRate.findFirst({ orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
        prisma.fxRate.count(),
        prisma.billPayment.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
        prisma.billPayment.count(),
        prisma.webhookEvent.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
        prisma.webhookEvent.count(),
      ]);

    sources.push(
      { name: "core.transactions", source: "Ledger CDC", latest: txLatest?.createdAt ?? null, count: txCount },
      { name: "core.users", source: "Ledger CDC", latest: userLatest?.createdAt ?? null, count: userCount },
      { name: "cards.authorisations", source: "Pagocards webhook", latest: authLatest?.createdAt ?? null, count: authCount },
      { name: "fx.rates", source: "FX desk", latest: fxLatest?.updatedAt ?? null, count: fxCount },
      { name: "bills.payments", source: "Strowallet", latest: billLatest?.createdAt ?? null, count: billCount },
      { name: "platform.webhooks", source: "Provider callbacks", latest: hookLatest?.createdAt ?? null, count: hookCount },
    );

    const pipelines = sources.map((s) => {
      const lagMs = s.latest ? now - s.latest.getTime() : Number.POSITIVE_INFINITY;
      return {
        name: s.name,
        source: s.source,
        lag: lagLabel(lagMs),
        status: pipelineStatus(lagMs),
        rows: compactCount(s.count),
      };
    });

    return { pipelines };
  }

  async referralConfig() {
    const cfg = await getConfig("engagement.referral_config", DEFAULT_REFERRAL_CONFIG);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const rewarded = await prisma.referralAttribution.aggregate({
      where: {
        status: { in: ["REWARDED", "QUALIFIED"] },
        createdAt: { gte: monthStart },
      },
      _sum: { rewardAmount: true },
      _count: true,
    });

    // Fraud-ish holds: PENDING older than holdDays
    const holdBefore = new Date(Date.now() - (cfg.holdDays || 7) * 86400000);
    const held = await prisma.referralAttribution.count({
      where: { status: "PENDING", createdAt: { lt: holdBefore } },
    });

    const fraudRules = (cfg.fraudRules || DEFAULT_REFERRAL_CONFIG.fraudRules).map((r, i) =>
      i === 0 ? { ...r, hits: held } : r,
    );

    return {
      ...DEFAULT_REFERRAL_CONFIG,
      ...cfg,
      fraudRules,
      spentThisMonth: Number(rewarded._sum.rewardAmount ?? 0),
      rewardedThisMonth: rewarded._count,
    };
  }

  async putReferralConfig(body: Record<string, unknown>) {
    const current = await getConfig("engagement.referral_config", DEFAULT_REFERRAL_CONFIG);
    const next = {
      ...current,
      ...body,
      fraudRules: Array.isArray(body.fraudRules) ? body.fraudRules : current.fraudRules,
    };
    await putConfig("engagement.referral_config", next);
    return this.referralConfig();
  }

  /**
   * Treasury desk for Fulus rails: Busha float, Flutterwave deposits, Pagocards,
   * Strowallet bills, virtual USD/SAR ledgers — not fictional Providus/Marqeta pools.
   */
  async treasury() {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const floors = await getConfig<Record<string, number>>("finance.treasury_floors", {});

    const [recon, walletByCcy, pendingDep, burn24, burn7, activeCards, lastSweepAt] = await Promise.all([
      floatJobsService.reconcile(),
      prisma.wallet.groupBy({
        by: ["currency"],
        _sum: { available: true, pending: true },
      }),
      prisma.deposit.groupBy({
        by: ["provider"],
        where: { status: "PENDING", currency: "NGN" },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.transaction.groupBy({
        by: ["type", "currency"],
        where: { createdAt: { gte: since24h }, status: { in: ["SUCCESS", "PENDING", "PROCESSING"] } },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.transaction.groupBy({
        by: ["type", "currency"],
        where: { createdAt: { gte: since7d }, status: { in: ["SUCCESS", "PENDING", "PROCESSING"] } },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.card.count({ where: { status: "ACTIVE" } }),
      prisma.adminAuditLog.findFirst({
        where: { action: { contains: "float" } },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
    ]);

    const wallet = (ccy: string) => {
      const row = walletByCcy.find((w) => w.currency === ccy);
      return {
        available: Number(row?._sum.available ?? 0),
        pending: Number(row?._sum.pending ?? 0),
      };
    };
    const pendingBy = (provider: string) => {
      const row = pendingDep.find((d) => d.provider === provider);
      return { amount: Number(row?._sum.amount ?? 0), count: row?._count ?? 0 };
    };
    const burn = (rows: typeof burn24, types: string[], ccy?: string) => {
      let amount = 0;
      let count = 0;
      for (const r of rows) {
        if (!types.includes(r.type)) continue;
        if (ccy && r.currency !== ccy) continue;
        amount += Math.abs(Number(r._sum.amount ?? 0));
        count += r._count;
      }
      return { amount, count };
    };

    const ngn = wallet("NGN");
    const usd = wallet("USD");
    const sar = wallet("SAR");
    const usdt = wallet("USDT");
    const bushaPending = pendingBy("busha");
    const fwPending = pendingBy("flutterwave");
    const withdraw24 = burn(burn24, ["WITHDRAWAL", "TRANSFER"], "NGN");
    const withdraw7 = burn(burn7, ["WITHDRAWAL", "TRANSFER"], "NGN");
    const card24 = burn(burn24, ["CARD_FUND", "CARD_WITHDRAW"]);
    const card7 = burn(burn7, ["CARD_FUND", "CARD_WITHDRAW"]);
    const crypto24 = burn(burn24, ["CRYPTO_BUY", "CRYPTO_SELL", "CRYPTO_SEND"]);
    const crypto7 = burn(burn7, ["CRYPTO_BUY", "CRYPTO_SELL", "CRYPTO_SEND"]);
    const bill24 = burn(burn24, ["BILL_PAYMENT", "ESIM_PURCHASE"], "NGN");
    const bill7 = burn(burn7, ["BILL_PAYMENT", "ESIM_PURCHASE"], "NGN");
    const swap24 = burn(burn24, ["SWAP"]);
    const swap7 = burn(burn7, ["SWAP"]);

    const dailyBurn = (b24: { amount: number }, b7: { amount: number }) =>
      Math.max(b24.amount, b7.amount / 7);
    const runway = (balance: number, encumbered: number, burnAmt: number) => {
      const free = Math.max(0, balance - encumbered);
      if (burnAmt <= 0) return free > 0 ? 168 : 0;
      return Math.round((free / burnAmt) * 10) / 10;
    };
    const floorOf = (id: string, fallback: number) =>
      Number.isFinite(floors[id]) && floors[id]! > 0 ? Number(floors[id]) : fallback;

    const now = recon.at || new Date().toISOString();
    const lastSweep = lastSweepAt?.createdAt.toISOString() ?? now;

    const masterNgn = Math.max(0, Number(recon.masterNgn) || 0);
    const liabilities = Number(recon.totalLiabilities) || ngn.available + ngn.pending;
    const masterFloor = floorOf("busha-master-ngn", Math.max(liabilities * 1.05, 50_000));

    type Pool = {
      id: string;
      name: string;
      kind: "bank" | "provider" | "exchange" | "card_program" | "chain";
      currency: "NGN" | "USD" | "SAR";
      balance: number;
      liability: number;
      encumbered: number;
      floor: number;
      runwayHours: number;
      burn24h: number;
      lastSweep: string;
      sweepable: boolean;
    };

    const accounts: Pool[] = [
      {
        id: "busha-master-ngn",
        name: "Busha — master NGN float",
        kind: "provider",
        currency: "NGN",
        balance: masterNgn,
        liability: liabilities,
        encumbered: Number(recon.pendingDepositNgn) || bushaPending.amount,
        floor: masterFloor,
        runwayHours: runway(masterNgn, Number(recon.pendingDepositNgn) || 0, dailyBurn(withdraw24, withdraw7) + dailyBurn(bill24, bill7)),
        burn24h: withdraw24.amount + bill24.amount,
        lastSweep,
        sweepable: true,
      },
      {
        id: "fulus-ledger-ngn",
        name: "Fulus ledger — customer NGN",
        kind: "bank",
        currency: "NGN",
        balance: ngn.available + ngn.pending,
        liability: ngn.available + ngn.pending,
        encumbered: ngn.pending,
        floor: floorOf("fulus-ledger-ngn", ngn.available + ngn.pending),
        runwayHours: runway(ngn.available + ngn.pending, ngn.pending, dailyBurn(withdraw24, withdraw7)),
        burn24h: withdraw24.amount,
        lastSweep: now,
        sweepable: false,
      },
      {
        id: "flutterwave-deposits-ngn",
        name: "Flutterwave — card deposit pipeline",
        kind: "provider",
        currency: "NGN",
        balance: fwPending.amount,
        liability: 0,
        encumbered: fwPending.amount,
        floor: floorOf("flutterwave-deposits-ngn", 0),
        runwayHours: fwPending.count ? 24 : 168,
        burn24h: 0,
        lastSweep: now,
        sweepable: false,
      },
      {
        id: "busha-pending-ngn",
        name: "Busha — pending NGN deposits",
        kind: "provider",
        currency: "NGN",
        balance: bushaPending.amount,
        liability: 0,
        encumbered: bushaPending.amount,
        floor: floorOf("busha-pending-ngn", 0),
        runwayHours: bushaPending.count ? 12 : 168,
        burn24h: 0,
        lastSweep: now,
        sweepable: true,
      },
      {
        id: "pagocards-usd",
        name: "Pagocards — card program",
        kind: "card_program",
        currency: "USD",
        balance: usd.available + usd.pending,
        liability: usd.available + usd.pending,
        encumbered: usd.pending,
        floor: floorOf("pagocards-usd", Math.max(activeCards * 5, 10)),
        runwayHours: runway(usd.available + usd.pending, usd.pending, dailyBurn(card24, card7) || 1),
        burn24h: card24.amount,
        lastSweep: now,
        sweepable: false,
      },
      {
        id: "busha-crypto",
        name: "Busha — crypto liquidity",
        kind: "exchange",
        currency: "USD",
        balance: usdt.available + usdt.pending + Math.max(0, usd.available * 0.15),
        liability: usdt.available + usdt.pending,
        encumbered: crypto24.amount > 0 ? crypto24.amount * 0.1 : 0,
        floor: floorOf("busha-crypto", Math.max(dailyBurn(crypto24, crypto7) * 2, 5)),
        runwayHours: runway(
          usdt.available + usdt.pending + Math.max(0, usd.available * 0.15),
          0,
          dailyBurn(crypto24, crypto7) || 1,
        ),
        burn24h: crypto24.amount,
        lastSweep: now,
        sweepable: true,
      },
      {
        id: "strowallet-bills",
        name: "Strowallet — bills / airtime float",
        kind: "provider",
        currency: "NGN",
        balance: Math.max(dailyBurn(bill24, bill7) * 3, bill7.amount),
        liability: 0,
        encumbered: bill24.amount,
        floor: floorOf("strowallet-bills", Math.max(dailyBurn(bill24, bill7) * 2, 1_000)),
        runwayHours: runway(Math.max(dailyBurn(bill24, bill7) * 3, bill7.amount), bill24.amount, dailyBurn(bill24, bill7) || 1),
        burn24h: bill24.amount,
        lastSweep: now,
        sweepable: true,
      },
      {
        id: "fulus-ledger-sar",
        name: "Fulus ledger — virtual SAR",
        kind: "bank",
        currency: "SAR",
        balance: sar.available + sar.pending,
        liability: sar.available + sar.pending,
        encumbered: sar.pending,
        floor: floorOf("fulus-ledger-sar", Math.max(sar.available + sar.pending, dailyBurn(swap24, swap7))),
        runwayHours: runway(sar.available + sar.pending, sar.pending, dailyBurn(swap24, swap7) || 1),
        burn24h: swap24.amount,
        lastSweep: now,
        sweepable: false,
      },
    ];

    type Rebalance = {
      id: string;
      from: string;
      to: string;
      currency: "NGN" | "USD" | "SAR";
      amount: number;
      reason: string;
      impact: string;
      urgency: "now" | "today" | "this week";
      action?: "sweep" | "topup" | "chase" | "swap";
    };

    const rebalances: Rebalance[] = [];
    let n = 1;
    const push = (r: Omit<Rebalance, "id">) => {
      if (!(r.amount > 0)) return;
      rebalances.push({ ...r, id: `RBL-${String(4400 + n++).padStart(4, "0")}` });
    };

    if (recon.shortfall > 0) {
      push({
        from: "flutterwave-deposits-ngn",
        to: "busha-master-ngn",
        currency: "NGN",
        amount: Math.ceil(recon.shortfall),
        reason: `Busha master float is ₦${Math.round(recon.shortfall).toLocaleString()} short of customer NGN liabilities`,
        impact: `Coverage restored · liabilities ₦${Math.round(liabilities).toLocaleString()} vs master ₦${Math.round(masterNgn).toLocaleString()}`,
        urgency: "now",
        action: "topup",
      });
    }

    if (bushaPending.amount > 0 && bushaPending.count > 0) {
      push({
        from: "busha-pending-ngn",
        to: "busha-master-ngn",
        currency: "NGN",
        amount: Math.ceil(bushaPending.amount),
        reason: `${bushaPending.count} Busha NGN deposit(s) still pending confirmation`,
        impact: "Confirm or expire stale deposits so float recon stops counting them as encumbered",
        urgency: bushaPending.amount > masterFloor * 0.1 ? "today" : "this week",
        action: "chase",
      });
    }

    if (fwPending.amount > 0 && fwPending.count >= 3) {
      push({
        from: "flutterwave-deposits-ngn",
        to: "fulus-ledger-ngn",
        currency: "NGN",
        amount: Math.ceil(fwPending.amount),
        reason: `${fwPending.count} Flutterwave card deposits pending (₦${Math.round(fwPending.amount).toLocaleString()})`,
        impact: "Chase provider settlement / verify webhooks so customer wallets credit",
        urgency: fwPending.count >= 10 ? "now" : "today",
        action: "chase",
      });
    }

    if (recon.surplus > SWEEP_HINT_NGN && recon.healthy) {
      push({
        from: "busha-pending-ngn",
        to: "busha-master-ngn",
        currency: "NGN",
        amount: Math.min(Math.ceil(recon.surplus * 0.25), 500_000),
        reason: "Master float healthy with surplus — sweep idle customer Busha NGN into master",
        impact: "Consolidates provider float · Fulus ledger unchanged",
        urgency: "this week",
        action: "sweep",
      });
    }

    const pago = accounts.find((a) => a.id === "pagocards-usd")!;
    if (pago.balance < pago.floor || (card7.count > 0 && pago.runwayHours < 24)) {
      const need = Math.max(pago.floor - pago.balance, dailyBurn(card24, card7) * 2, 5);
      push({
        from: "busha-master-ngn",
        to: "pagocards-usd",
        currency: "USD",
        amount: Math.ceil(need),
        reason: `Pagocards USD program below floor with ${activeCards} active card(s)`,
        impact: "Swap NGN→USD on the FX desk, then fund Pagocards to avoid CARD_FUND declines",
        urgency: pago.runwayHours < 12 ? "now" : "today",
        action: "swap",
      });
    }

    const stro = accounts.find((a) => a.id === "strowallet-bills")!;
    if (bill7.count > 0 && stro.balance < stro.floor) {
      push({
        from: "busha-master-ngn",
        to: "strowallet-bills",
        currency: "NGN",
        amount: Math.ceil(stro.floor - stro.balance + dailyBurn(bill24, bill7)),
        reason: "Strowallet bills working balance under desk floor at recent vend burn",
        impact: `Covers ~${bill7.count} successful bill vends over 7d`,
        urgency: "today",
        action: "topup",
      });
    }

    const belowFloor = accounts.filter((a) => a.balance < a.floor || a.runwayHours < 12).length;
    const idleSurplusNgn = accounts
      .filter((a) => a.currency === "NGN" && a.sweepable)
      .reduce((s, a) => s + Math.max(0, a.balance - a.floor - a.liability * 0.05), 0);

    return {
      at: now,
      recon,
      accounts,
      rebalances: rebalances.slice(0, 8),
      summary: {
        pools: accounts.length,
        belowFloor,
        idleSurplusNgn: Math.round(idleSurplusNgn),
        openRebalances: Math.min(rebalances.length, 8),
        currencies: [...new Set(accounts.map((a) => a.currency))],
      },
    };
  }
}

export const adminDeskService = new AdminDeskService();
