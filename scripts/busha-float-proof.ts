/**
 * Phase 0 sandbox proof helpers for Busha master float.
 * Run: npx tsx scripts/busha-float-proof.ts
 *
 * Requires BUSHA_SECRET_KEY (+ live SIMULATE_PROVIDERS=0) for real calls.
 * Without keys, prints the simulated path shapes.
 */
import "dotenv/config";
import { bushaFloatService } from "../src/providers/busha/float.js";
import { useBushaLive } from "../src/lib/simulate.js";

async function main() {
  console.log("Busha float proof");
  console.log("live=", useBushaLive());

  const deposit = await bushaFloatService.createMasterNgnDeposit(1000);
  console.log("master deposit:", {
    transferId: deposit.transferId,
    sourceAmount: deposit.sourceAmount,
    targetAmount: deposit.targetAmount,
    feeAmount: deposit.feeAmount,
    bank: deposit.bank,
    simulated: deposit.simulated,
  });

  try {
    const bal = await bushaFloatService.getMasterNgnBalance();
    console.log("master NGN balance:", bal);
  } catch (e) {
    console.warn("balance check failed:", e instanceof Error ? e.message : e);
  }

  console.log("\nPayout requires a real NG bank account — skipped by default.");
  console.log("Call bushaFloatService.payoutFromMaster({...}) manually in sandbox.");
  console.log("OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
