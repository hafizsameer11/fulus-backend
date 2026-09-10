import { PrismaClient, WalletCurrency, BillCategory } from "@prisma/client";

const prisma = new PrismaClient();

// Quote lookup uses base=toCurrency, quote=fromCurrency; midRate multiplies from→to.
// e.g. USD→NGN: base=NGN, quote=USD, midRate=1580 (1 USD buys 1580 NGN).
const FX_SEED: Array<{
  baseCurrency: WalletCurrency;
  quoteCurrency: WalletCurrency;
  midRate: number;
  baseBps: number;
}> = [
  { baseCurrency: "NGN", quoteCurrency: "USD", midRate: 1580, baseBps: 85 },
  { baseCurrency: "USD", quoteCurrency: "NGN", midRate: 1 / 1580, baseBps: 90 },
  { baseCurrency: "NGN", quoteCurrency: "SAR", midRate: 421, baseBps: 110 },
  { baseCurrency: "SAR", quoteCurrency: "NGN", midRate: 1 / 421, baseBps: 120 },
  { baseCurrency: "SAR", quoteCurrency: "USD", midRate: 3.75, baseBps: 65 },
  { baseCurrency: "USD", quoteCurrency: "SAR", midRate: 1 / 3.75, baseBps: 70 },
];

const BILL_SERVICES: Array<{
  id: string;
  category: BillCategory;
  name: string;
  shortName: string;
  logoKey: string;
  providerCode: string;
  accent?: string;
  variations?: Array<{ code: string; name: string; amount?: number }>;
}> = [
  { id: "mtn", category: "AIRTIME", name: "MTN", shortName: "MTN", logoKey: "mtn", providerCode: "mtn", accent: "#FFCC00" },
  { id: "airtel", category: "AIRTIME", name: "Airtel", shortName: "airtel", logoKey: "airtel", providerCode: "airtel", accent: "#ED1C24" },
  { id: "glo", category: "AIRTIME", name: "Glo", shortName: "glo", logoKey: "glo", providerCode: "glo", accent: "#00A650" },
  { id: "9mobile", category: "AIRTIME", name: "9mobile", shortName: "9", logoKey: "9mobile", providerCode: "9mobile", accent: "#0F9D58" },
  {
    id: "mtn-data",
    category: "DATA",
    name: "MTN Data",
    shortName: "MTN",
    logoKey: "mtn",
    providerCode: "mtn-data",
    accent: "#FFCC00",
    variations: [
      { code: "1gb-30d", name: "1GB · 30 days", amount: 500 },
      { code: "2gb-30d", name: "2GB · 30 days", amount: 1000 },
      { code: "5gb-30d", name: "5GB · 30 days", amount: 2500 },
    ],
  },
  {
    id: "airtel-data",
    category: "DATA",
    name: "Airtel Data",
    shortName: "airtel",
    logoKey: "airtel",
    providerCode: "airtel-data",
    accent: "#ED1C24",
    variations: [
      { code: "1gb-30d", name: "1GB · 30 days", amount: 500 },
      { code: "2gb-30d", name: "2GB · 30 days", amount: 1000 },
      { code: "5gb-30d", name: "5GB · 30 days", amount: 2500 },
    ],
  },
  { id: "ikedc", category: "ELECTRICITY", name: "Ikeja Electric", shortName: "IKEDC", logoKey: "ikedc", providerCode: "ikeja-electric", accent: "#F7941E" },
  { id: "ekedc", category: "ELECTRICITY", name: "Eko Electric", shortName: "EKEDC", logoKey: "ekedc", providerCode: "eko-electric", accent: "#8E24AA" },
  { id: "aedc", category: "ELECTRICITY", name: "Abuja Electric", shortName: "AEDC", logoKey: "aedc", providerCode: "abuja-electric", accent: "#00A651" },
  {
    id: "dstv",
    category: "CABLE",
    name: "DStv",
    shortName: "DStv",
    logoKey: "dstv",
    providerCode: "dstv",
    accent: "#0033A0",
    variations: [
      { code: "compact", name: "Compact", amount: 19000 },
      { code: "premium", name: "Premium", amount: 44500 },
    ],
  },
  {
    id: "gotv",
    category: "CABLE",
    name: "GOtv",
    shortName: "GOtv",
    logoKey: "gotv",
    providerCode: "gotv",
    accent: "#00A651",
    variations: [
      { code: "jolli", name: "Jolli", amount: 4850 },
      { code: "max", name: "Max", amount: 7200 },
    ],
  },
  {
    id: "startimes",
    category: "CABLE",
    name: "Startimes",
    shortName: "Startimes",
    logoKey: "startimes",
    providerCode: "startimes",
    accent: "#F26522",
    variations: [{ code: "classic", name: "Classic", amount: 5100 }],
  },
  { id: "bet9ja", category: "BETTING", name: "Bet9ja", shortName: "Bet9ja", logoKey: "bet9ja", providerCode: "bet9ja", accent: "#00A651" },
  { id: "sportybet", category: "BETTING", name: "SportyBet", shortName: "SportyBet", logoKey: "sportybet", providerCode: "sportybet", accent: "#E31E24" },
  { id: "1xbet", category: "BETTING", name: "1xBet", shortName: "1xBet", logoKey: "1xbet", providerCode: "1xbet", accent: "#1A73E8" },
  { id: "betking", category: "BETTING", name: "BetKing", shortName: "BetKing", logoKey: "betking", providerCode: "betking", accent: "#FFB800" },
  { id: "betway", category: "BETTING", name: "Betway", shortName: "Betway", logoKey: "betway", providerCode: "betway", accent: "#00A950" },
  { id: "nairabet", category: "BETTING", name: "NairaBet", shortName: "NairaBet", logoKey: "nairabet", providerCode: "nairabet", accent: "#0E7C3A" },
  { id: "merrybet", category: "BETTING", name: "Merrybet", shortName: "Merrybet", logoKey: "merrybet", providerCode: "merrybet", accent: "#DB2E2E" },
  { id: "22bet", category: "BETTING", name: "22Bet", shortName: "22Bet", logoKey: "22bet", providerCode: "22bet", accent: "#0057A0" },
  {
    id: "waec",
    category: "EDUCATION",
    name: "WAEC",
    shortName: "WAEC",
    logoKey: "waec",
    providerCode: "waec",
    accent: "#7C3AED",
    variations: [{ code: "scratch-card", name: "Result Checker", amount: 3400 }],
  },
];

async function main() {
  for (const row of FX_SEED) {
    await prisma.fxRate.upsert({
      where: {
        baseCurrency_quoteCurrency: {
          baseCurrency: row.baseCurrency,
          quoteCurrency: row.quoteCurrency,
        },
      },
      create: {
        ...row,
        tier1Bps: 35,
        tier2Bps: 12,
        tier3Bps: 0,
        active: true,
        createdBy: "seed",
      },
      update: {
        midRate: row.midRate,
        baseBps: row.baseBps,
        active: true,
      },
    });
  }

  for (const svc of BILL_SERVICES) {
    await prisma.billService.upsert({
      where: { id: svc.id },
      create: {
        id: svc.id,
        category: svc.category,
        name: svc.name,
        shortName: svc.shortName,
        logoKey: svc.logoKey,
        providerCode: svc.providerCode,
        accent: svc.accent,
        isActive: true,
      },
      update: {
        name: svc.name,
        shortName: svc.shortName,
        logoKey: svc.logoKey,
        providerCode: svc.providerCode,
        accent: svc.accent,
        isActive: true,
      },
    });

    for (const v of svc.variations ?? []) {
      await prisma.billVariation.upsert({
        where: { serviceId_code: { serviceId: svc.id, code: v.code } },
        create: {
          serviceId: svc.id,
          code: v.code,
          name: v.name,
          amount: v.amount,
          isActive: true,
        },
        update: {
          name: v.name,
          amount: v.amount,
          isActive: true,
        },
      });
    }
  }

  console.log(`Seeded ${FX_SEED.length} FX rates and ${BILL_SERVICES.length} bill services`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
