import { prisma } from "../../../lib/prisma.js";

const CONFIG_KEYS = {
  amlRules: "compliance.aml_rules",
  screenLists: "compliance.screen_lists",
  binRules: "cards.bin_rules",
  limitTiers: "cards.limit_tiers",
  mccRules: "cards.mcc_rules",
  savedReports: "analytics.saved_reports",
  funnels: "analytics.funnels",
} as const;

const DEFAULT_AML_RULES = [
  {
    id: "RUL-001",
    name: "Structuring below NGN reporting floor",
    family: "structuring",
    description: "3+ deposits between ₦900k and ₦1M from distinct sources inside the window.",
    threshold: 3,
    unit: "deposits",
    window: "24h",
    state: "live",
    alerts30d: 214,
    precision: 41,
    escalationRate: 18,
    owner: "Nneka Umeh",
    trend: [12, 15, 9, 18, 22, 17, 25, 21, 19, 28],
  },
  {
    id: "RUL-002",
    name: "Payout velocity spike",
    family: "velocity",
    description: "Payout count exceeds 6× the customer's own 30-day baseline.",
    threshold: 6,
    unit: "× baseline",
    window: "1h",
    state: "live",
    alerts30d: 388,
    precision: 27,
    escalationRate: 9,
    owner: "Tunde Ajayi",
    trend: [30, 26, 34, 41, 38, 44, 39, 47, 52, 44],
  },
  {
    id: "RUL-003",
    name: "Rapid in-out (pass-through)",
    family: "rapid_in_out",
    description: "≥85% of an inbound credit leaves the wallet within the window.",
    threshold: 85,
    unit: "% of credit",
    window: "30m",
    state: "live",
    alerts30d: 156,
    precision: 58,
    escalationRate: 33,
    owner: "Nneka Umeh",
    trend: [14, 11, 16, 13, 19, 17, 21, 18, 22, 20],
  },
];

const DEFAULT_SCREEN_LISTS = [
  { list: "OFAC SDN", records: 17422, version: "2026-07-28", enabled: true, fuzz: 82 },
  { list: "UN Consolidated", records: 9214, version: "2026-07-27", enabled: true, fuzz: 85 },
  { list: "NFIU PEP", records: 2311, version: "2026-07-20", enabled: true, fuzz: 78 },
];

const DEFAULT_BIN_RULES = [
  { id: "BIN-486236", bin: "486236", program: "Fulus Virtual USD", dailyUsd: 5000, monthlyUsd: 25000, mccBlock: ["7995", "6051"] },
  { id: "BIN-539983", bin: "539983", program: "Fulus Naira Card", dailyNgn: 1_000_000, monthlyNgn: 5_000_000, mccBlock: ["7995"] },
];

const DEFAULT_LIMIT_TIERS = [
  { id: "TIER-1", label: "Standard", perTxUsd: 1000, dailyUsd: 5000, monthlyUsd: 15000 },
  { id: "TIER-2", label: "Premium", perTxUsd: 5000, dailyUsd: 25000, monthlyUsd: 100000 },
];

const DEFAULT_MCC_RULES = [
  { mcc: "7995", label: "Gambling", action: "block", reason: "Policy" },
  { mcc: "6051", label: "Quasi-cash", action: "block", reason: "Policy" },
  { mcc: "5734", label: "Software & SaaS", action: "allow", reason: "Default" },
];

const DEFAULT_NETWORKS = [
  {
    id: "bitcoin",
    name: "Bitcoin",
    short: "BTC",
    assets: ["BTC"],
    status: "healthy",
    depositsEnabled: true,
    withdrawalsEnabled: true,
    confirmations: 2,
    avgBlockSec: 600,
    medianConfirmMin: 18,
    networkFeeUsd: 2.4,
    feePolicy: "customer",
    pendingDeposits: 12,
    pendingWithdrawals: 3,
    explorer: "mempool.space",
  },
  {
    id: "ethereum",
    name: "Ethereum",
    short: "ERC-20",
    assets: ["ETH", "USDT", "USDC"],
    status: "congested",
    depositsEnabled: true,
    withdrawalsEnabled: true,
    confirmations: 12,
    avgBlockSec: 12,
    medianConfirmMin: 42,
    networkFeeUsd: 11.8,
    feePolicy: "customer",
    pendingDeposits: 41,
    pendingWithdrawals: 9,
    notice: "Gas above 80 gwei — confirmations may take up to 45 minutes.",
    explorer: "etherscan.io",
  },
  {
    id: "tron",
    name: "Tron",
    short: "TRC-20",
    assets: ["USDT", "TRX"],
    status: "healthy",
    depositsEnabled: true,
    withdrawalsEnabled: true,
    confirmations: 19,
    avgBlockSec: 3,
    medianConfirmMin: 1.2,
    networkFeeUsd: 0.9,
    feePolicy: "hybrid",
    pendingDeposits: 64,
    pendingWithdrawals: 21,
    explorer: "tronscan.org",
  },
];

const DEFAULT_EXPOSURES = [
  { asset: "BTC", netPositionCoin: 2.4, netPositionUsd: 164208, limitUsd: 500000, hedgeRatio: 0.82, pnl24hUsd: 4200, autoHalt: false },
  { asset: "ETH", netPositionCoin: -18.2, netPositionUsd: -64080, limitUsd: 200000, hedgeRatio: 0.65, pnl24hUsd: -1200, autoHalt: false },
  { asset: "USDT", netPositionCoin: 890000, netPositionUsd: 890000, limitUsd: 2000000, hedgeRatio: 0.95, pnl24hUsd: 0, autoHalt: false },
];

const DEFAULT_FUNNELS = [
  {
    id: "signup-to-kyc",
    name: "Signup → KYC approved",
    steps: [
      { key: "signup", label: "Account created", count: 10000 },
      { key: "kyc_start", label: "KYC started", count: 7200 },
      { key: "kyc_approved", label: "KYC approved", count: 6100 },
    ],
  },
];

const DEFAULT_SAVED_REPORTS = [
  { id: "SR-001", name: "Weekly transaction volume", owner: "Ops", schedule: "weekly", lastRun: null },
  { id: "SR-002", name: "Card decline breakdown", owner: "Cards", schedule: "daily", lastRun: null },
];

export { CONFIG_KEYS };

async function upsertConfig(key: string, value: unknown) {
  const json = JSON.stringify(value);
  await prisma.platformConfig.upsert({
    where: { key },
    create: { key, value: json },
    update: { value: json },
  });
}

export async function ensureAdminModulesSeed() {
  const [amlCount, progCount, netCount] = await Promise.all([
    prisma.amlAlert.count(),
    prisma.cardProgram.count(),
    prisma.cryptoNetworkPolicy.count(),
  ]);

  const now = new Date();

  if (amlCount === 0) {
    await prisma.amlAlert.createMany({
      data: [
        {
          ruleId: "RUL-001",
          customerName: "Amaka Obi",
          score: 78,
          valueUsd: 4200,
          status: "open",
          assignee: "Nneka Umeh",
          narrative: "Four inbound bank credits of ₦940k each from unrelated senders, swept to one payout.",
          legs: { count: 4 },
          openedAt: new Date(now.getTime() - 12 * 3600000),
        },
        {
          ruleId: "RUL-002",
          customerName: "Tunde Bello",
          score: 65,
          valueUsd: 1800,
          status: "investigating",
          assignee: "Tunde Ajayi",
          narrative: "Payout count jumped from 2/day baseline to 14 in 40 minutes across 3 beneficiaries.",
          legs: { count: 14 },
          openedAt: new Date(now.getTime() - 36 * 3600000),
        },
        {
          ruleId: "RUL-003",
          customerName: "Fatima Yusuf",
          score: 91,
          valueUsd: 9600,
          status: "escalated",
          assignee: "Halima Sule",
          narrative: "USDT deposit fully swapped to NGN and withdrawn in 11 minutes.",
          legs: { count: 3 },
          openedAt: new Date(now.getTime() - 72 * 3600000),
        },
      ],
    });

    await prisma.sanctionHit.createMany({
      data: [
        {
          subject: "Amaka Obi",
          matchedName: "A. M. Bello",
          list: "OFAC SDN",
          matchScore: 94,
          dobDelta: "exact",
          country: "NG",
          program: "SDGT",
          status: "pending",
          context: "onboarding",
        },
        {
          subject: "Chidi Eze",
          matchedName: "Mohammed Sani Idris",
          list: "UN Consolidated",
          matchScore: 88,
          dobDelta: "2y apart",
          country: "NG",
          program: "NPWMD",
          status: "pending",
          context: "payout",
        },
      ],
    });

    await prisma.complianceCase.createMany({
      data: [
        {
          title: "Suspected pass-through network — 6 wallets",
          type: "AML",
          severity: "high",
          stage: "investigation",
          subject: "Amaka Obi",
          assignee: "Nneka Umeh",
          exposureUsd: 12400,
          linkedAlerts: ["RUL-003"],
          evidence: [{ id: "EVD-1", kind: "transaction", label: "Ledger extract", addedAt: now.toISOString(), by: "Nneka Umeh" }],
          narrative: "Pattern consistent with third-party layering.",
          dueAt: new Date(now.getTime() + 20 * 86400000),
        },
        {
          title: "OFAC 94% match on outbound payout",
          type: "Sanctions",
          severity: "critical",
          stage: "intake",
          subject: "Chidi Eze",
          assignee: "Halima Sule",
          exposureUsd: 3200,
          linkedAlerts: [],
          evidence: [],
          narrative: "Outbound payout name matched OFAC alias at 94%.",
          dueAt: new Date(now.getTime() + 14 * 86400000),
        },
      ],
    });

    await prisma.regReport.createMany({
      data: [
        {
          id: "RPT-2201",
          regulator: "CBN",
          name: "Daily returns — customer balances",
          cadence: "daily",
          period: "30 Jul 2026",
          status: "ready",
          dueAt: new Date(now.getTime() + 6 * 3600000),
          rows: 129102,
          retention: "7 years",
          owner: "Zara Okoye",
        },
        {
          id: "RPT-2205",
          regulator: "NFIU",
          name: "Suspicious transaction report batch",
          cadence: "monthly",
          period: "Jul 2026",
          status: "overdue",
          dueAt: new Date(now.getTime() - 3 * 86400000),
          rows: 14,
          retention: "5 years",
          owner: "Nneka Umeh",
        },
      ],
    });

    await prisma.dsrRequest.createMany({
      data: [
        {
          id: "DSR-510",
          kind: "export",
          subject: "Amaka Obi",
          status: "open",
          channel: "email",
          receivedAt: new Date(now.getTime() - 2 * 86400000),
          dueAt: new Date(now.getTime() + 28 * 86400000),
        },
        {
          id: "DSR-514",
          kind: "erase",
          subject: "Tunde Bello",
          status: "open",
          legalHold: true,
          holdReason: "Open dispute CAS-920",
          channel: "in-app",
          receivedAt: new Date(now.getTime() - 5 * 86400000),
          dueAt: new Date(now.getTime() + 25 * 86400000),
        },
      ],
    });
  }

  if (progCount === 0) {
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
          monthlyFeeUsd: 0,
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
          id: "PRG-003",
          name: "Fulus Naira Card (pilot)",
          network: "Mastercard",
          processor: "Stripe Issuing",
          bin: "539983",
          currency: "NGN",
          issuanceFeeUsd: 2,
          status: "pilot",
          cardsIssued: 1240,
          activeCards: 980,
          spend30dUsd: 96300,
          approvalRate: 88.2,
          bufferUsd: 45000,
          countries: ["NG"],
        },
      ],
    });

    await prisma.cardAuthorization.createMany({
      data: [
        {
          merchant: "Netflix.com",
          mcc: "5815",
          mccLabel: "Digital goods — media",
          country: "US",
          amount: 15.99,
          currency: "USD",
          billingAmount: 25264,
          fxRate: 1580,
          decision: "approved",
          last4: "4821",
          customerName: "Amaka Obi",
          threeDs: true,
          networkRef: "NET-8821",
          latencyMs: 420,
          riskScore: 12,
        },
        {
          merchant: "Meta Ads",
          mcc: "5734",
          mccLabel: "Software & SaaS",
          country: "IE",
          amount: 250,
          currency: "USD",
          billingAmount: 395000,
          fxRate: 1580,
          decision: "declined",
          declineCode: "51",
          last4: "9012",
          customerName: "Tunde Bello",
          threeDs: false,
          networkRef: "META-4412",
          latencyMs: 890,
          riskScore: 44,
        },
      ],
    });
  }

  if (netCount === 0) {
    for (const n of DEFAULT_NETWORKS) {
      await prisma.cryptoNetworkPolicy.create({
        data: {
          ...n,
          assets: n.assets,
          medianConfirmMin: n.medianConfirmMin,
          networkFeeUsd: n.networkFeeUsd,
        },
      });
    }
    for (const e of DEFAULT_EXPOSURES) {
      await prisma.cryptoExposure.create({ data: e });
    }
  }

  const engagementCount = await prisma.engagementCampaign.count();
  if (engagementCount === 0) {
    await prisma.engagementCampaign.createMany({
      data: [
        {
          channel: "inbox",
          name: "NIP instant payouts",
          status: "sent",
          payload: {
            title: "Your naira wallet now settles in seconds",
            body: "NIP payouts on Fulus are now instant for amounts under 1,000,000 naira.",
            audienceName: "High-value NGN savers",
            reach: 42000,
            read: 28000,
            tapped: 8400,
            status: "sent",
          },
        },
        {
          channel: "push",
          name: "Re-engagement 500 NGN",
          status: "draft",
          payload: {
            title: "We miss you",
            body: "Fund 5,000 NGN this week for 500 NGN bonus.",
            sent: 0,
            opened: 0,
            status: "draft",
          },
        },
        {
          channel: "journey",
          name: "KYC completion nudge",
          status: "live",
          payload: {
            steps: 4,
            entered: 1200,
            completed: 610,
            status: "live",
          },
        },
      ],
    });
  }

  const cfgRows = await prisma.platformConfig.findMany({
    where: { key: { in: Object.values(CONFIG_KEYS) } },
    select: { key: true },
  });
  const have = new Set(cfgRows.map((r) => r.key));
  const ts = now.toISOString();

  if (!have.has(CONFIG_KEYS.amlRules)) {
    await upsertConfig(
      CONFIG_KEYS.amlRules,
      DEFAULT_AML_RULES.map((r) => ({ ...r, updatedAt: ts })),
    );
  }
  if (!have.has(CONFIG_KEYS.screenLists)) {
    await upsertConfig(
      CONFIG_KEYS.screenLists,
      DEFAULT_SCREEN_LISTS.map((l) => ({ ...l, syncedAt: ts })),
    );
  }
  if (!have.has(CONFIG_KEYS.binRules)) await upsertConfig(CONFIG_KEYS.binRules, DEFAULT_BIN_RULES);
  if (!have.has(CONFIG_KEYS.limitTiers)) await upsertConfig(CONFIG_KEYS.limitTiers, DEFAULT_LIMIT_TIERS);
  if (!have.has(CONFIG_KEYS.mccRules)) await upsertConfig(CONFIG_KEYS.mccRules, DEFAULT_MCC_RULES);
  if (!have.has(CONFIG_KEYS.funnels)) await upsertConfig(CONFIG_KEYS.funnels, DEFAULT_FUNNELS);
  if (!have.has(CONFIG_KEYS.savedReports)) await upsertConfig(CONFIG_KEYS.savedReports, DEFAULT_SAVED_REPORTS);
}
