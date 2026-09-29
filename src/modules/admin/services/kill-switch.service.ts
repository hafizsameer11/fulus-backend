import { z } from "zod";
import { prisma } from "../../../lib/prisma.js";
import { KILL_SWITCH_KEYS, invalidateKillSwitchCache } from "../../../lib/kill-switch.js";

const KNOWN_KEYS = Object.values(KILL_SWITCH_KEYS);

export const putKillSwitchesSchema = z.object({
  switches: z.record(z.string(), z.boolean()),
});

export class KillSwitchService {
  async list() {
    const rows = await prisma.platformConfig.findMany({
      where: { key: { in: KNOWN_KEYS } },
    });
    const map = new Map(rows.map((r) => [r.key, r.value === "1" || r.value === "true"]));
    return {
      switches: KNOWN_KEYS.map((key) => ({ key, enabled: map.get(key) ?? false })),
    };
  }

  async upsert(input: z.infer<typeof putKillSwitchesSchema>) {
    const allowed = new Set<string>(KNOWN_KEYS);
    for (const [key, enabled] of Object.entries(input.switches)) {
      if (!allowed.has(key)) continue;
      await prisma.platformConfig.upsert({
        where: { key },
        create: { key, value: enabled ? "1" : "0" },
        update: { value: enabled ? "1" : "0" },
      });
    }
    invalidateKillSwitchCache();
    return this.list();
  }
}

export const killSwitchService = new KillSwitchService();
