import { prisma } from "../../../lib/prisma.js";
import { useBushaLive } from "../../../lib/simulate.js";
import { bushaFloatService } from "../../../providers/busha/float.js";

/** Leave this much NGN on each customer Busha profile (dust / future sells). */
const SWEEP_THRESHOLD_NGN = 500;
/** Alert when master float falls this far below Fulus liabilities. */
const FLOAT_SHORTFALL_ALERT_NGN = 1;

export type FloatReconResult = {
  at: string;
  live: boolean;
  masterNgn: number;
  fulusNgnLiabilities: number;
  pendingDepositNgn: number;
  totalLiabilities: number;
  surplus: number;
  shortfall: number;
  healthy: boolean;
};

export class FloatJobsService {
  /**
   * Sweep customer Busha NGN balances above threshold into the business master float.
   * Fulus ledger is unchanged (float consolidation only).
   */
  async sweepCustomerBalances(opts?: { threshold?: number; limit?: number }) {
    const threshold = opts?.threshold ?? SWEEP_THRESHOLD_NGN;
    const limit = opts?.limit ?? 40;
    const live = useBushaLive();

    const customers = await prisma.user.findMany({
      where: { bushaCustomerId: { not: null } },
      select: { id: true, bushaCustomerId: true, email: true },
      take: limit,
      orderBy: { updatedAt: "desc" },
    });

    const results: Array<{
      userId: string;
      customerId: string;
      balance: number;
      swept: number;
      transferId?: string;
      error?: string;
      skipped?: boolean;
    }> = [];

    for (const user of customers) {
      const customerId = user.bushaCustomerId!;
      try {
        const balance = live ? await bushaFloatService.getCustomerNgnBalance(customerId) : 0;
        if (balance <= threshold) {
          results.push({
            userId: user.id,
            customerId,
            balance,
            swept: 0,
            skipped: true,
          });
          continue;
        }
        const amount = Math.floor((balance - threshold) * 100) / 100;
        if (!(amount > 0)) {
          results.push({
            userId: user.id,
            customerId,
            balance,
            swept: 0,
            skipped: true,
          });
          continue;
        }

        const payout = await bushaFloatService.sweepCustomerNgnToMaster(customerId, amount);
        results.push({
          userId: user.id,
          customerId,
          balance,
          swept: amount,
          transferId: payout.transferId,
        });
      } catch (err) {
        results.push({
          userId: user.id,
          customerId,
          balance: 0,
          swept: 0,
          error: err instanceof Error ? err.message : "sweep failed",
        });
      }
    }

    return {
      at: new Date().toISOString(),
      live,
      threshold,
      sweptCount: results.filter((r) => r.swept > 0).length,
      results,
    };
  }

  /** Master Busha NGN vs Σ Fulus NGN wallets + pending Busha deposits. */
  async reconcile(): Promise<FloatReconResult> {
    const live = useBushaLive();

    const [walletAgg, pendingAgg] = await Promise.all([
      prisma.wallet.aggregate({
        where: { currency: "NGN" },
        _sum: { available: true, pending: true },
      }),
      prisma.deposit.aggregate({
        where: {
          currency: "NGN",
          status: "PENDING",
          provider: { in: ["busha", "busha-sim"] },
        },
        _sum: { amount: true },
      }),
    ]);

    const available = Number(walletAgg._sum.available ?? 0);
    const pendingWallet = Number(walletAgg._sum.pending ?? 0);
    const fulusNgnLiabilities = available + pendingWallet;
    const pendingDepositNgn = Number(pendingAgg._sum.amount ?? 0);
    const totalLiabilities = fulusNgnLiabilities + pendingDepositNgn;

    let masterNgn = 0;
    if (live) {
      try {
        masterNgn = await bushaFloatService.getMasterNgnBalance();
      } catch {
        masterNgn = Number.NaN;
      }
    } else {
      masterNgn = totalLiabilities;
    }

    const surplus = Number.isFinite(masterNgn) ? masterNgn - totalLiabilities : 0;
    const shortfall = surplus < 0 ? Math.abs(surplus) : 0;
    const healthy = Number.isFinite(masterNgn) && shortfall < FLOAT_SHORTFALL_ALERT_NGN;

    const result: FloatReconResult = {
      at: new Date().toISOString(),
      live,
      masterNgn: Number.isFinite(masterNgn) ? masterNgn : -1,
      fulusNgnLiabilities,
      pendingDepositNgn,
      totalLiabilities,
      surplus,
      shortfall,
      healthy,
    };

    if (!healthy && live) {
      console.warn("[float-recon] SHORTFALL", JSON.stringify(result));
    }

    return result;
  }

  async runDailyJobs() {
    const recon = await this.reconcile();
    const sweep = await this.sweepCustomerBalances();
    return { recon, sweep };
  }
}

export const floatJobsService = new FloatJobsService();

let _timers: ReturnType<typeof setInterval>[] = [];

/** Start background float sweep + recon (idempotent). */
export function startFloatJobScheduler() {
  if (_timers.length) return;

  const hour = 60 * 60 * 1000;
  _timers.push(
    setInterval(() => {
      void floatJobsService.reconcile().catch((e) => {
        console.warn("[float-recon]", e instanceof Error ? e.message : e);
      });
    }, 6 * hour),
  );
  _timers.push(
    setInterval(() => {
      void floatJobsService.sweepCustomerBalances().catch((e) => {
        console.warn("[float-sweep]", e instanceof Error ? e.message : e);
      });
    }, 12 * hour),
  );

  setTimeout(() => {
    void floatJobsService.reconcile().catch(() => undefined);
  }, 15_000);

  console.log("[float-jobs] scheduler started (recon 6h, sweep 12h)");
}
