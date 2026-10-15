import { randomBytes } from "node:crypto";
import { prisma } from "../../../lib/prisma.js";
import { env } from "../../../config/env.js";
import { AppError } from "../../../lib/errors.js";
import { walletService } from "../../wallet/services/wallet.service.js";

function normalizeCode(raw: string) {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

/** Strip optional FULUS- prefix for DB lookup. */
function bareCode(raw: string) {
  return normalizeCode(raw).replace(/^FULUS-?/i, "");
}

/** Prototype-style share code: FULUS-XXXXXXXX */
export function formatDisplayCode(raw: string | null | undefined) {
  if (!raw) return "";
  const bare = bareCode(raw);
  return bare ? `FULUS-${bare}` : "";
}

export function generateReferralCode() {
  return randomBytes(4).toString("hex").toUpperCase();
}

export class ReferralsService {
  rewardAmount() {
    return env.REFERRAL_REWARD_NGN;
  }

  async ensureUserReferralCode(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { referralCode: true } });
    if (!user) throw new AppError("User not found", 404);
    if (user.referralCode) return user.referralCode;

    for (let i = 0; i < 8; i++) {
      const referralCode = generateReferralCode();
      try {
        const updated = await prisma.user.update({
          where: { id: userId },
          data: { referralCode },
          select: { referralCode: true },
        });
        return updated.referralCode!;
      } catch {
        // unique collision — retry
      }
    }
    throw new AppError("Could not allocate referral code", 500);
  }

  async applyReferralAtSignup(referredUserId: string, codeRaw: string | undefined) {
    if (!codeRaw?.trim()) return null;
    const code = normalizeCode(codeRaw);
    const bare = bareCode(code);

    const referrer = await prisma.user.findFirst({
      where: {
        OR: [{ referralCode: code }, { referralCode: bare }, { referralCode: formatDisplayCode(bare) }],
      },
    });
    if (!referrer || referrer.id === referredUserId) return null;

    const existing = await prisma.referralAttribution.findUnique({ where: { referredUserId } });
    if (existing) return existing;

    return prisma.referralAttribution.create({
      data: {
        referrerUserId: referrer.id,
        referredUserId,
        code: referrer.referralCode ?? bare,
        rewardAmount: this.rewardAmount(),
      },
    });
  }

  /**
   * When a referred user becomes KYC-approved, mark attribution QUALIFIED and
   * credit both wallets (idempotent — skips if already REWARDED).
   */
  async qualifyAndRewardForUser(referredUserId: string) {
    const attr = await prisma.referralAttribution.findUnique({ where: { referredUserId } });
    if (!attr || attr.status === "REWARDED") return null;

    if (attr.status === "PENDING") {
      await prisma.referralAttribution.update({
        where: { id: attr.id },
        data: { status: "QUALIFIED" },
      });
    }

    const amount = Number(attr.rewardAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return prisma.referralAttribution.update({
        where: { id: attr.id },
        data: { status: "REWARDED" },
      });
    }

    // Re-check after qualify to avoid double-pay under concurrent KYC sync.
    const fresh = await prisma.referralAttribution.findUnique({ where: { id: attr.id } });
    if (!fresh || fresh.status === "REWARDED") return fresh;

    const meta = { referralAttributionId: attr.id, kind: "referral_reward" };
    await walletService.credit({
      userId: attr.referrerUserId,
      currency: "NGN",
      amount,
      type: "ADJUSTMENT",
      description: "Referral reward",
      metadata: meta,
    });
    await walletService.credit({
      userId: attr.referredUserId,
      currency: "NGN",
      amount,
      type: "ADJUSTMENT",
      description: "Referral welcome bonus",
      metadata: meta,
    });

    return prisma.referralAttribution.update({
      where: { id: attr.id },
      data: { status: "REWARDED" },
    });
  }

  async getMyReferrals(userId: string) {
    const code = await this.ensureUserReferralCode(userId);
    const displayCode = formatDisplayCode(code);
    const rewardNgn = this.rewardAmount();

    const attributions = await prisma.referralAttribution.findMany({
      where: { referrerUserId: userId },
      orderBy: { createdAt: "desc" },
      include: {
        referred: { select: { id: true, firstName: true, lastName: true, kycStatus: true, createdAt: true } },
      },
    });

    const joined = attributions.length;
    const qualified = attributions.filter(
      (a) => a.status === "QUALIFIED" || a.status === "REWARDED" || a.referred.kycStatus === "APPROVED",
    ).length;
    const earnedNgn = attributions
      .filter((a) => a.status === "REWARDED")
      .reduce((sum, a) => sum + Number(a.rewardAmount), 0);

    return {
      code: displayCode,
      rawCode: code,
      shareText: `Join me on Fulus — use code ${displayCode}`,
      rewardNgn,
      rewardCurrency: "NGN",
      stats: {
        sent: joined,
        joined,
        qualified,
        earnedNgn,
      },
      referrals: attributions.map((a) => {
        const name = [a.referred.firstName, a.referred.lastName].filter(Boolean).join(" ").trim() || "Friend";
        const earned = a.status === "REWARDED";
        return {
          id: a.id,
          status: a.status,
          rewardAmount: Number(a.rewardAmount),
          createdAt: a.createdAt,
          name,
          earned,
          referred: a.referred,
        };
      }),
    };
  }
}

export const referralsService = new ReferralsService();
