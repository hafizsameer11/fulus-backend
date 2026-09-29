import { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { AppError, NotFoundError } from "../../../lib/errors.js";

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

async function getConfig<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma.platformConfig.findUnique({ where: { key } });
  if (!row?.value) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

async function putConfig(key: string, value: unknown) {
  const raw = JSON.stringify(value);
  await prisma.platformConfig.upsert({
    where: { key },
    create: { key, value: raw },
    update: { value: raw },
  });
  return value;
}

async function audit(actor: string, action: string, subjectId: string | null, detail: string, meta?: unknown) {
  return prisma.adminAuditLog.create({
    data: {
      actor: actor || "admin",
      action,
      subjectId: subjectId ?? undefined,
      detail,
      meta: meta != null ? asJson(meta) : undefined,
    },
  });
}

const DEFAULT_AML_RULES = [
  {
    id: "RULE-VEL-01",
    name: "Velocity spike",
    family: "velocity",
    description: "More than N outbound transfers in a rolling window",
    threshold: 8,
    unit: "txns",
    window: "1h",
    state: "live",
    alerts30d: 42,
    precision: 0.71,
    escalationRate: 0.18,
    owner: "Compliance",
    updatedAt: new Date().toISOString(),
    trend: [12, 18, 14, 22, 19, 28, 24],
  },
  {
    id: "RULE-STR-02",
    name: "Structuring near threshold",
    family: "structuring",
    description: "Repeated amounts just under CTR reporting floor",
    threshold: 950,
    unit: "USD",
    window: "24h",
    state: "live",
    alerts30d: 19,
    precision: 0.64,
    escalationRate: 0.31,
    owner: "Compliance",
    updatedAt: new Date().toISOString(),
    trend: [4, 6, 5, 9, 7, 8, 6],
  },
];

const DEFAULT_SCREEN_LISTS = [
  { list: "OFAC SDN", records: 14200, version: "2026-09-01", syncedAt: new Date().toISOString(), enabled: true, fuzz: 0.86 },
  { list: "UN Consolidated", records: 980, version: "2026-08-15", syncedAt: new Date().toISOString(), enabled: true, fuzz: 0.9 },
  { list: "EU Consolidated", records: 2100, version: "2026-08-20", syncedAt: new Date().toISOString(), enabled: true, fuzz: 0.88 },
];

const DEFAULT_BIN_RULES = [
  { id: "BIN-001", bin: "486236", program: "Fulus Virtual USD", network: "Visa", range: "486236000000–486236999999", country: "NG", status: "active", utilisation: 0.62, capacity: 100000 },
  { id: "BIN-002", bin: "539983", program: "Fulus Naira Card", network: "Mastercard", range: "539983000000–539983999999", country: "NG", status: "pilot", utilisation: 0.18, capacity: 25000 },
];

const DEFAULT_LIMIT_TIERS = [
  { tier: "tier1", kyc: "NIN", perTxUsd: 200, dailyUsd: 500, monthlyUsd: 2000, maxCards: 1, atmUsd: 0 },
  { tier: "tier2", kyc: "NIN + selfie", perTxUsd: 1000, dailyUsd: 3000, monthlyUsd: 15000, maxCards: 2, atmUsd: 200 },
  { tier: "tier3", kyc: "Full KYC", perTxUsd: 5000, dailyUsd: 20000, monthlyUsd: 100000, maxCards: 5, atmUsd: 1000 },
];

const DEFAULT_MCC_RULES = [
  { mcc: "7995", label: "Gambling", action: "block", note: "Regulatory block" },
  { mcc: "6011", label: "ATM cash", action: "limit", note: "Tier ATM cap applies" },
  { mcc: "5816", label: "Digital goods", action: "allow", note: "" },
];

export class AdminModulesService {
  /* ----------------------------- config catalogs ---------------------------- */

  async getAmlRules() {
    return getConfig("compliance.aml_rules", DEFAULT_AML_RULES);
  }

  async putAmlRules(rules: unknown, actor = "admin") {
    const saved = await putConfig("compliance.aml_rules", rules);
    await audit(actor, "compliance.aml_rules.publish", null, "AML rules published");
    return saved;
  }

  async getScreenLists() {
    return getConfig("compliance.screen_lists", DEFAULT_SCREEN_LISTS);
  }

  async putScreenLists(lists: unknown, actor = "admin") {
    const saved = await putConfig("compliance.screen_lists", lists);
    await audit(actor, "compliance.screen_lists.publish", null, "Screen lists updated");
    return saved;
  }

  async getBinRules() {
    return getConfig("cards.bin_rules", DEFAULT_BIN_RULES);
  }

  async putBinRules(rules: unknown, actor = "admin") {
    const saved = await putConfig("cards.bin_rules", rules);
    await audit(actor, "cards.bin_rules.publish", null, "BIN rules published");
    return saved;
  }

  async getLimitTiers() {
    return getConfig("cards.limit_tiers", DEFAULT_LIMIT_TIERS);
  }

  async putLimitTiers(tiers: unknown, actor = "admin") {
    const saved = await putConfig("cards.limit_tiers", tiers);
    await audit(actor, "cards.limit_tiers.publish", null, "Card limit tiers published");
    return saved;
  }

  async getMccRules() {
    return getConfig("cards.mcc_rules", DEFAULT_MCC_RULES);
  }

  async putMccRules(rules: unknown, actor = "admin") {
    const saved = await putConfig("cards.mcc_rules", rules);
    await audit(actor, "cards.mcc_rules.publish", null, "MCC rules published");
    return saved;
  }

  async getSavedReports() {
    return getConfig("analytics.saved_reports", [] as unknown[]);
  }

  async putSavedReports(reports: unknown, actor = "admin") {
    const saved = await putConfig("analytics.saved_reports", reports);
    await audit(actor, "analytics.reports.save", null, "Saved analytics reports");
    return saved;
  }

  /* -------------------------------- AML alerts ------------------------------ */

  async ensureAmlSeed() {
    const count = await prisma.amlAlert.count();
    if (count > 0) return;
    await prisma.amlAlert.createMany({
      data: [
        {
          ruleId: "RULE-VEL-01",
          customerName: "Demo User",
          score: 86,
          valueUsd: 4200,
          status: "open",
          assignee: "Halima Sule",
          narrative: "Eight outbound NGN transfers within 52 minutes totaling ₦6.4m.",
          legs: [{ label: "NGN→USDT", amount: 2100 }, { label: "Payout", amount: 2100 }],
        },
        {
          ruleId: "RULE-STR-02",
          customerName: "Ada Okeke",
          score: 74,
          valueUsd: 940,
          status: "investigating",
          assignee: "Tunde Ajayi",
          narrative: "Five deposits of $940–$980 across linked devices in 18h.",
          legs: [{ label: "Card top-up", amount: 940 }],
        },
      ],
    });
  }

  async listAmlAlerts(status?: string) {
    await this.ensureAmlSeed();
    const where = status && status !== "all" ? { status } : {};
    const alerts = await prisma.amlAlert.findMany({ where, orderBy: { openedAt: "desc" }, take: 200 });
    return alerts.map((a) => ({
      id: a.id,
      ruleId: a.ruleId,
      customerId: a.userId ?? "",
      name: a.customerName,
      score: a.score,
      valueUsd: Number(a.valueUsd),
      status: a.status,
      openedAt: a.openedAt.toISOString(),
      ageHours: Math.max(0, (Date.now() - a.openedAt.getTime()) / 3600000),
      assignee: a.assignee,
      narrative: a.narrative,
      legs: a.legs ?? [],
    }));
  }

  async amlAlertAction(id: string, action: "clear" | "escalate", actor = "admin", reason = "") {
    const alert = await prisma.amlAlert.findUnique({ where: { id } });
    if (!alert) throw new NotFoundError("AML alert not found");
    if (action === "clear") {
      const updated = await prisma.amlAlert.update({ where: { id }, data: { status: "cleared" } });
      await audit(actor, "compliance.aml.alert.clear", id, reason || "Alert cleared");
      return updated;
    }
    const updated = await prisma.amlAlert.update({ where: { id }, data: { status: "escalated" } });
    await prisma.complianceCase.create({
      data: {
        title: `Escalated: ${alert.ruleId}`,
        type: "aml",
        severity: alert.score >= 80 ? "high" : "medium",
        stage: "intake",
        userId: alert.userId,
        subject: alert.customerName,
        assignee: alert.assignee || actor,
        exposureUsd: alert.valueUsd,
        linkedAlerts: [alert.id],
        narrative: alert.narrative,
      },
    });
    await audit(actor, "compliance.aml.alert.escalate", id, reason || "Escalated to case");
    return updated;
  }

  /* ------------------------------- Sanctions -------------------------------- */

  async ensureSanctionSeed() {
    const count = await prisma.sanctionHit.count();
    if (count > 0) return;
    await prisma.sanctionHit.createMany({
      data: [
        {
          subject: "Ibrahim Musa",
          matchedName: "IBRAHIM MUSA",
          list: "OFAC SDN",
          matchScore: 91,
          country: "NG",
          program: "SDGT",
          status: "pending",
          maker: "Nneka Umeh",
          context: "Name + DOB proximity on outbound FX beneficiary screen.",
        },
        {
          subject: "Grace Okon",
          matchedName: "GRACE OKON",
          list: "UN Consolidated",
          matchScore: 78,
          country: "NG",
          program: "UNSCR",
          status: "pending",
          maker: "Bode Adeniyi",
          context: "Partial name match on crypto withdrawal destination tag.",
        },
      ],
    });
  }

  async listSanctionHits(status?: string, list?: string) {
    await this.ensureSanctionSeed();
    const where: Record<string, string> = {};
    if (status && status !== "all") where.status = status;
    if (list && list !== "all") where.list = list;
    const hits = await prisma.sanctionHit.findMany({ where, orderBy: { screenedAt: "desc" }, take: 200 });
    return hits.map((h) => ({
      id: h.id,
      customerId: h.userId ?? "",
      subject: h.subject,
      matchedName: h.matchedName,
      list: h.list,
      matchScore: h.matchScore,
      dobDelta: h.dobDelta,
      country: h.country,
      program: h.program,
      status: h.status,
      screenedAt: h.screenedAt.toISOString(),
      maker: h.maker,
      checker: h.checker,
      context: h.context,
    }));
  }

  async sanctionHitAction(id: string, action: "clear" | "confirm", actor = "admin", reason = "") {
    const hit = await prisma.sanctionHit.findUnique({ where: { id } });
    if (!hit) throw new NotFoundError("Sanction hit not found");
    const status = action === "clear" ? "cleared" : "confirmed";
    const updated = await prisma.sanctionHit.update({
      where: { id },
      data: { status, checker: actor },
    });
    await audit(actor, `compliance.sanctions.${action}`, id, reason || status);
    return updated;
  }

  /* --------------------------------- Cases ---------------------------------- */

  async ensureCaseSeed() {
    const count = await prisma.complianceCase.count();
    if (count > 0) return;
    await prisma.complianceCase.create({
      data: {
        title: "Suspected structuring on USD corridor",
        type: "aml",
        severity: "high",
        stage: "intake",
        subject: "Ada Okeke",
        assignee: "Halima Sule",
        exposureUsd: 12400,
        linkedAlerts: [],
        evidence: [],
        narrative: "Pattern of sub-threshold deposits followed by crypto buys.",
        dueAt: new Date(Date.now() + 5 * 86400000),
      },
    });
  }

  async listCases(filters: { type?: string; severity?: string; assignee?: string } = {}) {
    await this.ensureCaseSeed();
    const where: Record<string, string> = {};
    if (filters.type && filters.type !== "all") where.type = filters.type;
    if (filters.severity && filters.severity !== "all") where.severity = filters.severity;
    if (filters.assignee && filters.assignee !== "all") where.assignee = filters.assignee;
    const cases = await prisma.complianceCase.findMany({ where, orderBy: { openedAt: "desc" }, take: 200 });
    return cases.map((c) => this.mapCase(c));
  }

  async getCase(id: string) {
    const c = await prisma.complianceCase.findUnique({ where: { id } });
    if (!c) throw new NotFoundError("Case not found");
    return this.mapCase(c);
  }

  private mapCase(c: {
    id: string;
    title: string;
    type: string;
    severity: string;
    stage: string;
    userId: string | null;
    subject: string;
    assignee: string;
    exposureUsd: Prisma.Decimal;
    linkedAlerts: unknown;
    evidence: unknown;
    narrative: string;
    sarRef: string | null;
    openedAt: Date;
    dueAt: Date | null;
  }) {
    return {
      id: c.id,
      title: c.title,
      type: c.type,
      severity: c.severity,
      stage: c.stage,
      customerId: c.userId ?? "",
      subject: c.subject,
      assignee: c.assignee,
      openedAt: c.openedAt.toISOString(),
      dueAt: c.dueAt?.toISOString() ?? null,
      exposureUsd: Number(c.exposureUsd),
      linkedAlerts: Array.isArray(c.linkedAlerts) ? c.linkedAlerts : [],
      evidence: Array.isArray(c.evidence) ? c.evidence : [],
      narrative: c.narrative,
      sarRef: c.sarRef,
    };
  }

  async advanceCase(id: string, stage: string, actor = "admin", reason = "") {
    const c = await prisma.complianceCase.findUnique({ where: { id } });
    if (!c) throw new NotFoundError("Case not found");
    const updated = await prisma.complianceCase.update({
      where: { id },
      data: {
        stage,
        ...(stage === "sar_filed" ? { sarRef: c.sarRef || `STR-${Date.now().toString().slice(-8)}` } : {}),
      },
    });
    await audit(actor, "compliance.case.advance", id, reason || `Stage → ${stage}`);
    return this.mapCase(updated);
  }

  /* ---------------------------- Reports / DSR ------------------------------- */

  async ensureReportSeed() {
    const count = await prisma.regReport.count();
    if (count > 0) return;
    await prisma.regReport.createMany({
      data: [
        {
          regulator: "CBN",
          name: "Monthly CTR summary",
          cadence: "monthly",
          period: "2026-08",
          status: "draft",
          dueAt: new Date(Date.now() + 10 * 86400000),
          rows: 1284,
          owner: "Compliance",
        },
        {
          regulator: "NFIU",
          name: "STR batch",
          cadence: "ad-hoc",
          period: "2026-Q3",
          status: "ready",
          dueAt: new Date(Date.now() + 3 * 86400000),
          rows: 12,
          owner: "Compliance",
        },
      ],
    });
  }

  async listReports() {
    await this.ensureReportSeed();
    const rows = await prisma.regReport.findMany({ orderBy: { dueAt: "asc" }, take: 100 });
    return rows.map((r) => ({
      id: r.id,
      regulator: r.regulator,
      name: r.name,
      cadence: r.cadence,
      period: r.period,
      status: r.status,
      dueAt: r.dueAt?.toISOString() ?? null,
      submittedAt: r.submittedAt?.toISOString() ?? null,
      ref: r.ref,
      rows: r.rows,
      retention: r.retention,
      owner: r.owner,
    }));
  }

  async submitReport(id: string, actor = "admin", reason = "") {
    const r = await prisma.regReport.findUnique({ where: { id } });
    if (!r) throw new NotFoundError("Report not found");
    const updated = await prisma.regReport.update({
      where: { id },
      data: {
        status: "submitted",
        submittedAt: new Date(),
        ref: r.ref || `${r.regulator}-${Date.now().toString().slice(-6)}`,
      },
    });
    await audit(actor, "compliance.report.submit", id, reason || "Report submitted");
    return updated;
  }

  async ensureDsrSeed() {
    const count = await prisma.dsrRequest.count();
    if (count > 0) return;
    await prisma.dsrRequest.create({
      data: {
        kind: "access",
        subject: "Chinedu Obi",
        status: "open",
        channel: "email",
        dueAt: new Date(Date.now() + 14 * 86400000),
      },
    });
  }

  async listDsr() {
    await this.ensureDsrSeed();
    const rows = await prisma.dsrRequest.findMany({ orderBy: { dueAt: "asc" }, take: 100 });
    return rows.map((d) => ({
      id: d.id,
      kind: d.kind,
      customerId: d.userId ?? "",
      subject: d.subject,
      receivedAt: d.receivedAt.toISOString(),
      dueAt: d.dueAt?.toISOString() ?? null,
      status: d.status,
      legalHold: d.legalHold,
      holdReason: d.holdReason,
      channel: d.channel,
    }));
  }

  async dsrAction(id: string, action: "fulfil" | "refuse", actor = "admin", reason = "") {
    const d = await prisma.dsrRequest.findUnique({ where: { id } });
    if (!d) throw new NotFoundError("DSR not found");
    const status = action === "fulfil" ? "fulfilled" : "refused";
    const updated = await prisma.dsrRequest.update({ where: { id }, data: { status } });
    await audit(actor, `compliance.dsr.${action}`, id, reason || status);
    return updated;
  }

  /* --------------------------------- Cards ---------------------------------- */

  async ensureCardProgramSeed() {
    const count = await prisma.cardProgram.count();
    if (count > 0) return;
    await prisma.cardProgram.createMany({
      data: [
        {
          id: "PRG-001",
          name: "Fulus Virtual USD",
          network: "Visa",
          processor: "Marqeta",
          bin: "486236",
          currency: "USD",
          issuanceFeeUsd: 6,
          fxMarkupPct: 1.5,
          status: "live",
          cardsIssued: 41820,
          activeCards: 28407,
          spend30dUsd: 3940500,
          approvalRate: 93.4,
          bufferUsd: 640000,
          countries: ["NG", "SA", "US", "GB", "EU"],
        },
        {
          id: "PRG-002",
          name: "Fulus Merchant Locked",
          network: "Visa",
          processor: "Marqeta",
          bin: "486241",
          currency: "USD",
          issuanceFeeUsd: 6,
          monthlyFeeUsd: 1,
          fxMarkupPct: 1.5,
          status: "live",
          cardsIssued: 9140,
          activeCards: 6902,
          spend30dUsd: 812400,
          approvalRate: 95.1,
          bufferUsd: 120000,
          countries: ["NG", "SA"],
        },
      ],
    });
  }

  async listCardPrograms() {
    await this.ensureCardProgramSeed();
    const rows = await prisma.cardProgram.findMany({ orderBy: { name: "asc" } });
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      network: p.network,
      processor: p.processor,
      bin: p.bin,
      currency: p.currency,
      formFactor: p.formFactor,
      issuanceFeeUsd: Number(p.issuanceFeeUsd),
      monthlyFeeUsd: Number(p.monthlyFeeUsd),
      fxMarkupPct: Number(p.fxMarkupPct),
      status: p.status,
      cardsIssued: p.cardsIssued,
      activeCards: p.activeCards,
      spend30dUsd: Number(p.spend30dUsd),
      approvalRate: Number(p.approvalRate),
      bufferUsd: Number(p.bufferUsd),
      countries: Array.isArray(p.countries) ? p.countries : [],
    }));
  }

  async upsertCardProgram(body: Record<string, unknown>, actor = "admin") {
    const id = String(body.id ?? `PRG-${Date.now().toString().slice(-6)}`);
    const data = {
      name: String(body.name ?? "Program"),
      network: String(body.network ?? "Visa"),
      processor: String(body.processor ?? ""),
      bin: String(body.bin ?? ""),
      currency: String(body.currency ?? "USD"),
      formFactor: String(body.formFactor ?? "virtual"),
      issuanceFeeUsd: Number(body.issuanceFeeUsd ?? 0),
      monthlyFeeUsd: Number(body.monthlyFeeUsd ?? 0),
      fxMarkupPct: Number(body.fxMarkupPct ?? 0),
      status: String(body.status ?? "live"),
      cardsIssued: Number(body.cardsIssued ?? 0),
      activeCards: Number(body.activeCards ?? 0),
      spend30dUsd: Number(body.spend30dUsd ?? 0),
      approvalRate: Number(body.approvalRate ?? 0),
      bufferUsd: Number(body.bufferUsd ?? 0),
      countries: asJson(body.countries ?? []),
    };
    const row = await prisma.cardProgram.upsert({
      where: { id },
      create: { id, ...data },
      update: data,
    });
    await audit(actor, "cards.program.upsert", id, `Upserted ${row.name}`);
    return row;
  }

  async ensureAuthSeed() {
    const count = await prisma.cardAuthorization.count();
    if (count > 0) return;
    const now = Date.now();
    await prisma.cardAuthorization.createMany({
      data: [
        {
          last4: "4242",
          customerName: "Demo User",
          merchant: "Netflix",
          mcc: "4899",
          mccLabel: "Cable/Streaming",
          country: "US",
          amount: 15.99,
          billingAmount: 15.99,
          decision: "approved",
          threeDs: false,
          riskScore: 12,
          latencyMs: 180,
          at: new Date(now - 120000),
        },
        {
          last4: "1881",
          customerName: "Ada Okeke",
          merchant: "Steam",
          mcc: "5816",
          mccLabel: "Digital goods",
          country: "NL",
          amount: 49.99,
          billingAmount: 49.99,
          decision: "declined",
          declineCode: "do_not_honor",
          threeDs: true,
          riskScore: 71,
          latencyMs: 240,
          at: new Date(now - 3600000),
        },
      ],
    });
  }

  async listCardAuthorisations(filters: { decision?: string; q?: string } = {}) {
    await this.ensureAuthSeed();
    const where: Prisma.CardAuthorizationWhereInput = {};
    if (filters.decision && filters.decision !== "all") where.decision = filters.decision;
    if (filters.q?.trim()) {
      const q = filters.q.trim();
      where.OR = [
        { merchant: { contains: q } },
        { customerName: { contains: q } },
        { last4: { contains: q } },
        { mcc: { contains: q } },
      ];
    }
    const rows = await prisma.cardAuthorization.findMany({ where, orderBy: { at: "desc" }, take: 200 });
    return rows.map((a) => ({
      id: a.id,
      at: a.at.toISOString(),
      cardId: a.cardId ?? "",
      last4: a.last4,
      customerId: a.userId ?? "",
      customerName: a.customerName,
      merchant: a.merchant,
      mcc: a.mcc,
      mccLabel: a.mccLabel,
      country: a.country,
      amount: Number(a.amount),
      currency: a.currency,
      billingAmount: Number(a.billingAmount),
      fxRate: Number(a.fxRate),
      decision: a.decision,
      declineCode: a.declineCode,
      threeDs: a.threeDs,
      networkRef: a.networkRef,
      latencyMs: a.latencyMs,
      riskScore: a.riskScore,
    }));
  }

  async reverseAuth(id: string, actor = "admin", reason = "") {
    const a = await prisma.cardAuthorization.findUnique({ where: { id } });
    if (!a) throw new NotFoundError("Authorisation not found");
    if (a.decision !== "approved") throw new AppError("Only approved auths can be reversed", 400);
    const updated = await prisma.cardAuthorization.update({
      where: { id },
      data: { decision: "reversed" },
    });
    await audit(actor, "cards.auth.reverse", id, reason || "Auth reversed");
    return updated;
  }

  /* --------------------------------- Crypto --------------------------------- */

  async ensureNetworkSeed() {
    const count = await prisma.cryptoNetworkPolicy.count();
    if (count > 0) return;
    await prisma.cryptoNetworkPolicy.createMany({
      data: [
        {
          id: "bitcoin",
          name: "Bitcoin",
          short: "BTC",
          assets: ["BTC"],
          status: "healthy",
          confirmations: 2,
          avgBlockSec: 600,
          medianConfirmMin: 18,
          networkFeeUsd: 2.4,
          feePolicy: "customer",
          explorer: "mempool.space",
        },
        {
          id: "ethereum",
          name: "Ethereum",
          short: "ERC-20",
          assets: ["ETH", "USDT", "USDC"],
          status: "congested",
          confirmations: 12,
          avgBlockSec: 12,
          medianConfirmMin: 42,
          networkFeeUsd: 11.8,
          feePolicy: "customer",
          notice: "Gas elevated — confirmations may take longer.",
          explorer: "etherscan.io",
        },
        {
          id: "tron",
          name: "Tron",
          short: "TRC-20",
          assets: ["USDT", "TRX"],
          status: "healthy",
          confirmations: 19,
          avgBlockSec: 3,
          medianConfirmMin: 1.2,
          networkFeeUsd: 0.9,
          feePolicy: "hybrid",
          explorer: "tronscan.org",
        },
      ],
    });
  }

  async listNetworks() {
    await this.ensureNetworkSeed();
    const rows = await prisma.cryptoNetworkPolicy.findMany({ orderBy: { name: "asc" } });
    return rows.map((n) => ({
      id: n.id,
      name: n.name,
      short: n.short,
      assets: Array.isArray(n.assets) ? n.assets : [],
      status: n.status,
      depositsEnabled: n.depositsEnabled,
      withdrawalsEnabled: n.withdrawalsEnabled,
      confirmations: n.confirmations,
      avgBlockSec: n.avgBlockSec,
      medianConfirmMin: Number(n.medianConfirmMin),
      networkFeeUsd: Number(n.networkFeeUsd),
      feePolicy: n.feePolicy,
      pendingDeposits: n.pendingDeposits,
      pendingWithdrawals: n.pendingWithdrawals,
      notice: n.notice ?? undefined,
      explorer: n.explorer,
    }));
  }

  async upsertNetwork(id: string, body: Record<string, unknown>, actor = "admin") {
    const data = {
      name: String(body.name ?? id),
      short: String(body.short ?? ""),
      assets: asJson(body.assets ?? []),
      status: String(body.status ?? "healthy"),
      depositsEnabled: body.depositsEnabled !== false,
      withdrawalsEnabled: body.withdrawalsEnabled !== false,
      confirmations: Number(body.confirmations ?? 1),
      avgBlockSec: Number(body.avgBlockSec ?? 0),
      medianConfirmMin: Number(body.medianConfirmMin ?? 0),
      networkFeeUsd: Number(body.networkFeeUsd ?? 0),
      feePolicy: String(body.feePolicy ?? "customer"),
      pendingDeposits: Number(body.pendingDeposits ?? 0),
      pendingWithdrawals: Number(body.pendingWithdrawals ?? 0),
      notice: body.notice != null ? String(body.notice) : null,
      explorer: String(body.explorer ?? ""),
    };
    const row = await prisma.cryptoNetworkPolicy.upsert({
      where: { id },
      create: { id, ...data },
      update: data,
    });
    await audit(actor, "crypto.network.upsert", id, `Updated ${row.name}`);
    return row;
  }

  async ensureExposureSeed() {
    const count = await prisma.cryptoExposure.count();
    if (count > 0) return;
    await prisma.cryptoExposure.createMany({
      data: [
        { asset: "BTC", netPositionCoin: 12.4, netPositionUsd: 848000, limitUsd: 1000000, hedgeRatio: 0.72, pnl24hUsd: 18400, autoHalt: false },
        { asset: "ETH", netPositionCoin: 210, netPositionUsd: 740000, limitUsd: 900000, hedgeRatio: 0.65, pnl24hUsd: -4200, autoHalt: false },
        { asset: "USDT", netPositionCoin: 2400000, netPositionUsd: 2400000, limitUsd: 5000000, hedgeRatio: 0.98, pnl24hUsd: 1200, autoHalt: false },
      ],
    });
  }

  async listExposures() {
    await this.ensureExposureSeed();
    const rows = await prisma.cryptoExposure.findMany({ orderBy: { asset: "asc" } });
    return rows.map((e) => ({
      asset: e.asset,
      netPositionCoin: Number(e.netPositionCoin),
      netPositionUsd: Number(e.netPositionUsd),
      limitUsd: Number(e.limitUsd),
      hedgeRatio: Number(e.hedgeRatio),
      pnl24hUsd: Number(e.pnl24hUsd),
      autoHalt: e.autoHalt,
    }));
  }

  async upsertExposure(asset: string, body: Record<string, unknown>, actor = "admin") {
    const code = asset.toUpperCase();
    const data = {
      netPositionCoin: Number(body.netPositionCoin ?? 0),
      netPositionUsd: Number(body.netPositionUsd ?? 0),
      limitUsd: Number(body.limitUsd ?? 0),
      hedgeRatio: Number(body.hedgeRatio ?? 0),
      pnl24hUsd: Number(body.pnl24hUsd ?? 0),
      autoHalt: Boolean(body.autoHalt),
    };
    const row = await prisma.cryptoExposure.upsert({
      where: { asset: code },
      create: { asset: code, ...data },
      update: data,
    });
    await audit(actor, "crypto.exposure.upsert", code, `Updated exposure ${code}`);
    return row;
  }

  async haltAllQuoting(actor = "admin", reason = "") {
    await this.ensureExposureSeed();
    await prisma.cryptoExposure.updateMany({ data: { autoHalt: true } });
    await audit(actor, "crypto.liquidity.halt", null, reason || "Halt all quoting");
    return this.listExposures();
  }

  /* ------------------------------ Engagement -------------------------------- */

  async listCampaigns(channel?: string): Promise<Record<string, unknown>[]> {
    const where = channel ? { channel } : {};
    const rows = await prisma.engagementCampaign.findMany({ where, orderBy: { updatedAt: "desc" }, take: 200 });
    if (!rows.length && channel) {
      await this.seedEngagementChannel(channel);
      return this.listCampaigns(channel);
    }
    return rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      name: r.name,
      status: r.status,
      ...(typeof r.payload === "object" && r.payload && !Array.isArray(r.payload)
        ? (r.payload as Record<string, unknown>)
        : {}),
    }));
  }

  private async seedEngagementChannel(channel: string) {
    const seeds: Record<string, Array<{ name: string; status: string; payload: Record<string, unknown> }>> = {
      inbox: [
        {
          name: "Welcome to Fulus",
          status: "sent",
          payload: {
            title: "Welcome to Fulus",
            body: "Your multi-currency wallet is ready.",
            audienceId: "all",
            audienceName: "All users",
            reach: 120000,
            locales: ["en", "ha"],
            pinned: true,
            read: 82000,
            tapped: 21000,
            author: "Growth",
            sentAt: new Date().toISOString(),
          },
        },
      ],
      push: [
        {
          name: "FX desk open",
          status: "scheduled",
          payload: {
            title: "NGN→USD rates refreshed",
            body: "Swap now before the window closes.",
            deepLink: "/swap",
            audienceName: "Active traders",
            quietHours: true,
            frequencyCapPerWeek: 3,
            sendAt: new Date(Date.now() + 3600000).toISOString(),
            targeted: 42000,
            eligible: 39000,
            delivered: 0,
            opened: 0,
            converted: 0,
            optedOut: 120,
            channel: "push",
          },
        },
      ],
      journey: [
        {
          name: "First deposit → first swap",
          status: "live",
          payload: {
            goal: "Complete first FX swap within 7 days of deposit",
            entered: 18420,
            active: 4200,
            converted: 6100,
            steps: [
              { kind: "trigger", label: "First NGN deposit", detail: "≥ ₦5,000" },
              { kind: "wait", label: "Wait 2h", detail: "" },
              { kind: "push", label: "Hint: try USD wallet", detail: "Deep link /swap", drop: 0.22 },
              { kind: "goal", label: "Swap completed", detail: "" },
            ],
          },
        },
      ],
      promo: [
        {
          name: "WELCOME500",
          status: "live",
          payload: {
            code: "WELCOME500",
            kind: "cashback",
            value: "₦500",
            audience: "New signups",
            startsAt: new Date(Date.now() - 7 * 86400000).toISOString(),
            endsAt: new Date(Date.now() + 30 * 86400000).toISOString(),
            budget: 5000000,
            spent: 820000,
            redemptions: 1640,
            redemptionCap: 10000,
            perUser: 1,
            stackable: false,
          },
        },
      ],
      experiment: [
        {
          name: "Swap CTA copy",
          status: "running",
          payload: {
            hypothesis: "Shorter CTA lifts swap completion",
            surface: "swap_confirm",
            audience: "Tier 1–2",
            startedAt: new Date(Date.now() - 5 * 86400000).toISOString(),
            primaryMetric: "swap_complete_rate",
            variants: [
              { key: "A", label: "Control", split: 50, exposed: 12000, conversion: 0.18, metricValue: 0.18 },
              { key: "B", label: "Shorter CTA", split: 50, exposed: 11950, conversion: 0.21, metricValue: 0.21 },
            ],
            guardrails: ["No increase in support tickets"],
            autoStop: true,
          },
        },
      ],
    };
    const list = seeds[channel] ?? [];
    for (const s of list) {
      await prisma.engagementCampaign.create({
        data: {
          channel,
          name: s.name,
          status: s.status,
          payload: asJson(s.payload),
        },
      });
    }
  }

  async upsertCampaign(body: Record<string, unknown>, actor = "admin") {
    const channel = String(body.channel ?? "inbox");
    const name = String(body.name ?? body.title ?? "Campaign");
    const status = String(body.status ?? "draft");
    const id = typeof body.id === "string" && body.id ? body.id : undefined;
    const { channel: _c, name: _n, status: _s, id: _i, ...rest } = body;
    const payload = asJson(rest);
    const row = id
      ? await prisma.engagementCampaign.upsert({
          where: { id },
          create: { id, channel, name, status, payload },
          update: { channel, name, status, payload },
        })
      : await prisma.engagementCampaign.create({ data: { channel, name, status, payload } });
    await audit(actor, "engagement.campaign.upsert", row.id, `Upserted ${channel}:${name}`);
    return row;
  }

  async campaignAction(id: string, action: "launch" | "pause" | "end", actor = "admin", reason = "") {
    const c = await prisma.engagementCampaign.findUnique({ where: { id } });
    if (!c) throw new NotFoundError("Campaign not found");
    const status = action === "launch" ? "live" : action === "pause" ? "paused" : "ended";
    const updated = await prisma.engagementCampaign.update({ where: { id }, data: { status } });
    await audit(actor, `engagement.campaign.${action}`, id, reason || status);
    return updated;
  }

  /* ------------------------------- Analytics -------------------------------- */

  async metricSeries(key: string, rangeDays = 30) {
    const since = new Date(Date.now() - rangeDays * 86400000);
    if (key === "signups") {
      const users = await prisma.user.findMany({
        where: { createdAt: { gte: since } },
        select: { createdAt: true },
        orderBy: { createdAt: "asc" },
      });
      return this.bucketByDay(users.map((u) => u.createdAt), rangeDays);
    }
    if (key === "volume" || key === "fees" || key === "tx_count") {
      const txs = await prisma.transaction.findMany({
        where: { createdAt: { gte: since }, status: "SUCCESS" },
        select: { createdAt: true, amount: true, fee: true },
      });
      if (key === "tx_count") return this.bucketByDay(txs.map((t) => t.createdAt), rangeDays);
      if (key === "fees") {
        return this.bucketSumByDay(
          txs.map((t) => ({ at: t.createdAt, value: Number(t.fee) })),
          rangeDays,
        );
      }
      return this.bucketSumByDay(
        txs.map((t) => ({ at: t.createdAt, value: Number(t.amount) })),
        rangeDays,
      );
    }
    // fallback empty series
    return this.bucketByDay([], rangeDays);
  }

  private bucketByDay(dates: Date[], days: number) {
    const buckets = Array.from({ length: days }, (_, i) => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - (days - 1 - i));
      return { t: d.toISOString().slice(0, 10), v: 0 };
    });
    const index = new Map(buckets.map((b, i) => [b.t, i]));
    for (const at of dates) {
      const key = at.toISOString().slice(0, 10);
      const i = index.get(key);
      if (i != null) buckets[i]!.v += 1;
    }
    return buckets;
  }

  private bucketSumByDay(rows: { at: Date; value: number }[], days: number) {
    const buckets = Array.from({ length: days }, (_, i) => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - (days - 1 - i));
      return { t: d.toISOString().slice(0, 10), v: 0 };
    });
    const index = new Map(buckets.map((b, i) => [b.t, i]));
    for (const row of rows) {
      const key = row.at.toISOString().slice(0, 10);
      const i = index.get(key);
      if (i != null) buckets[i]!.v += row.value;
    }
    return buckets;
  }

  async cohorts() {
    const since = new Date(Date.now() - 180 * 86400000);
    const users = await prisma.user.groupBy({
      by: ["createdAt"],
      where: { createdAt: { gte: since } },
      _count: true,
    });
    // Monthly cohorts simplified
    const byMonth = new Map<string, number>();
    for (const u of users) {
      const label = u.createdAt.toISOString().slice(0, 7);
      byMonth.set(label, (byMonth.get(label) ?? 0) + u._count);
    }
    return [...byMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, size]) => ({
        label,
        size,
        channel: "organic",
        values: {
          retention: [1, 0.62, 0.48, 0.41, 0.36, 0.33],
          revenue: [0, size * 12, size * 18, size * 22, size * 25, size * 28],
          txn_rate: [0.4, 0.35, 0.32, 0.3, 0.28, 0.27],
        },
      }));
  }

  async funnels() {
    const users = await prisma.user.count();
    const funded = await prisma.deposit.count({ where: { status: "SUCCESS" } });
    const swapped = await prisma.swap.count({ where: { status: "SUCCESS" } });
    const carded = await prisma.card.count();
    return [
      {
        id: "onboarding",
        name: "Signup → funded → swap → card",
        steps: [
          { label: "Signed up", users, medianMins: 0, dropReasons: [] },
          { label: "First deposit", users: funded, medianMins: 180, dropReasons: [{ reason: "Abandoned VA", share: 0.4 }] },
          { label: "First swap", users: swapped, medianMins: 420, dropReasons: [{ reason: "Rate hesitation", share: 0.35 }] },
          { label: "Issued card", users: carded, medianMins: 1440, dropReasons: [{ reason: "KYC incomplete", share: 0.5 }] },
        ],
        segmentSplit: [
          { segment: "Organic", share: 0.55 },
          { segment: "Referral", share: 0.25 },
          { segment: "Paid", share: 0.2 },
        ],
      },
    ];
  }
}

export const adminModulesService = new AdminModulesService();
