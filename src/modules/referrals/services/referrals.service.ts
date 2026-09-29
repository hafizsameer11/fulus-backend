import { randomBytes } from "node:crypto";
import { prisma } from "../../../lib/prisma.js";
import { env } from "../../../config/env.js";
import { AppError } from "../../../lib/errors.js";

function normalizeCode(raw: string) {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
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

    const referrer = await prisma.user.findFirst({
      where: {
        OR: [{ referralCode: code }, { referralCode: code.replace(/^FULUS-?/i, "") }],
      },
    });
    if (!referrer || referrer.id === referredUserId) return null;

    const existing = await prisma.referralAttribution.findUnique({ where: { referredUserId } });
    if (existing) return existing;

    return prisma.referralAttribution.create({
      data: {
        referrerUserId: referrer.id,
        referredUserId,
        code: referrer.referralCode ?? code,
        rewardAmount: this.rewardAmount(),
      },
    });
  }

  async getMyReferrals(userId: string) {
    const code = await this.ensureUserReferralCode(userId);
    const rewardNgn = this.rewardAmount();

    const attributions = await prisma.referralAttribution.findMany({
      where: { referrerUserId: userId },
      orderBy: { createdAt: "desc" },
      include: {
        referred: { select: { id: true, firstName: true, lastName: true, kycStatus: true, createdAt: true } },
      },
    });

    const joined = attributions.length;
    const qualified = attributions.filter((a) => a.referred.kycStatus === "APPROVED").length;
    const earnedNgn = attributions
      .filter((a) => a.status === "REWARDED" || a.referred.kycStatus === "APPROVED")
      .reduce((sum, a) => sum + Number(a.rewardAmount), 0);

    return {
      code,
      shareText: `Join me on Fulus — use code ${code}`,
      rewardNgn,
      rewardCurrency: "NGN",
      stats: {
        sent: joined,
        joined,
        qualified,
        earnedNgn,
      },
      referrals: attributions.map((a) => ({
        id: a.id,
        status: a.status,
        rewardAmount: Number(a.rewardAmount),
        createdAt: a.createdAt,
        referred: a.referred,
      })),
    };
  }
}

export const referralsService = new ReferralsService();
