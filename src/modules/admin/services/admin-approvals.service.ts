import type { Prisma } from "@prisma/client";
import { AppError, ForbiddenError, NotFoundError } from "../../../lib/errors.js";
import { prisma } from "../../../lib/prisma.js";
import { adminConsoleService } from "./admin-console.service.js";

function asJson(value: Record<string, unknown> | undefined): Prisma.InputJsonValue | undefined {
  if (!value) return undefined;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

const APPROVAL_CLASSES = [
  "refund",
  "ledger",
  "tier",
  "config",
  "sanctions",
  "payout",
  "keys",
] as const;

export type ApprovalClass = (typeof APPROVAL_CLASSES)[number];

type DiffRow = { field: string; before: string; after: string };
type CheckRow = { label: string; ok: boolean };

type CreateInput = {
  cls: string;
  title: string;
  module?: string;
  reason: string;
  risk?: "high" | "medium" | "low";
  amount?: string;
  subjectId?: string;
  sourcePath?: string;
  diff?: DiffRow[];
  checks?: CheckRow[];
  effects?: string[];
  actionType?: string;
  actionPayload?: Record<string, unknown>;
  expiresInHours?: number;
};

function parseJsonArray<T>(raw: string | null | undefined, fallback: T[]): T[] {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as T[];
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function nextPublicId() {
  for (let i = 0; i < 8; i++) {
    const n = Math.floor(Math.random() * 9000) + 1000;
    const publicId = `APR-${n}`;
    const exists = await prisma.adminApprovalRequest.findUnique({ where: { publicId }, select: { id: true } });
    if (!exists) return publicId;
  }
  return `APR-${Date.now().toString().slice(-6)}`;
}

function mapRow(row: {
  id: string;
  publicId: string;
  cls: string;
  title: string;
  module: string;
  requesterId: string;
  requesterName: string;
  requesterEmail: string;
  reason: string;
  risk: string;
  amount: string | null;
  subjectId: string | null;
  sourcePath: string;
  diffJson: string;
  checksJson: string;
  effectsJson: string | null;
  actionType: string | null;
  actionPayload: string | null;
  status: string;
  decidedById: string | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  comment: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}) {
  const status = row.status as "pending" | "approved" | "rejected" | "expired";
  return {
    id: row.publicId,
    dbId: row.id,
    cls: row.cls,
    title: row.title,
    module: row.module,
    requester: row.requesterName,
    requesterId: row.requesterId,
    requesterEmail: row.requesterEmail,
    requestedAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    risk: (row.risk === "high" || row.risk === "low" ? row.risk : "medium") as "high" | "medium" | "low",
    amount: row.amount ?? undefined,
    reason: row.reason,
    diff: parseJsonArray<DiffRow>(row.diffJson, []),
    checks: parseJsonArray<CheckRow>(row.checksJson, []),
    effects: parseJsonArray<string>(row.effectsJson, []),
    to: row.sourcePath,
    state: status === "expired" ? "rejected" : status === "pending" ? "pending" : status,
    status,
    subjectId: row.subjectId ?? undefined,
    actionType: row.actionType ?? undefined,
    actionPayload: parseJsonObject(row.actionPayload) ?? undefined,
    decided: status === "approved" || status === "rejected" ? status : undefined,
    decidedAt: row.decidedAt?.toISOString(),
    decidedBy: row.decidedByName ?? undefined,
    decidedById: row.decidedById ?? undefined,
    comment: row.comment ?? undefined,
  };
}

async function expireIfNeeded(id: string, expiresAt: Date, status: string) {
  if (status !== "pending") return status;
  if (expiresAt.getTime() > Date.now()) return status;
  await prisma.adminApprovalRequest.update({
    where: { id },
    data: { status: "expired" },
  });
  return "expired";
}

async function executeAction(
  actionType: string | null,
  actionPayload: Record<string, unknown> | null,
  actor: string,
) {
  if (!actionType) return;
  const payload = actionPayload ?? {};
  const userId = typeof payload.userId === "string" ? payload.userId : null;

  switch (actionType) {
    case "user.set_tier": {
      if (!userId) throw new AppError("Approval payload missing userId", 400);
      const tier = Number(payload.tier ?? 0);
      await adminConsoleService.setUserTier(userId, tier, actor);
      return;
    }
    case "user.freeze": {
      if (!userId) throw new AppError("Approval payload missing userId", 400);
      await adminConsoleService.setUserStatus(userId, "FROZEN", actor);
      return;
    }
    case "user.unfreeze": {
      if (!userId) throw new AppError("Approval payload missing userId", 400);
      await adminConsoleService.setUserStatus(userId, "ACTIVE", actor);
      return;
    }
    case "user.limit_override": {
      if (!userId) throw new AppError("Approval payload missing userId", 400);
      const key = `user.limit_override.${userId}`;
      const value = JSON.stringify({
        userId,
        dailyLimitNgn: payload.dailyLimitNgn ?? 5_000_000,
        expiresAt: payload.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        approvedBy: actor,
        at: new Date().toISOString(),
      });
      await prisma.platformConfig.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
      await prisma.adminAuditLog.create({
        data: {
          actor,
          action: "user.limit_override",
          subjectId: userId,
          detail: `Daily payout limit override applied (${String(payload.dailyLimitNgn ?? 5_000_000)})`,
          meta: asJson(payload),
        },
      });
      return;
    }
    case "user.close": {
      if (!userId) throw new AppError("Approval payload missing userId", 400);
      await adminConsoleService.setUserStatus(userId, "CLOSED", actor);
      return;
    }
    case "transaction.manual_settle": {
      const transactionId = typeof payload.transactionId === "string" ? payload.transactionId : null;
      if (!transactionId) throw new AppError("Approval payload missing transactionId", 400);
      await adminConsoleService.settleTransaction(transactionId, actor);
      return;
    }
    case "refund.card_deposit": {
      const depositId = typeof payload.depositId === "string" ? payload.depositId : null;
      if (!depositId) throw new AppError("Approval payload missing depositId", 400);
      const note = typeof payload.note === "string" ? payload.note : undefined;
      await adminConsoleService.refundCardPayment(depositId, actor, note);
      return;
    }
    case "config.deposit_card": {
      const value = typeof payload.value === "string" ? payload.value : JSON.stringify(payload.settings ?? payload);
      const key = typeof payload.key === "string" ? payload.key : "deposit.card.settings";
      await prisma.platformConfig.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
      await prisma.adminAuditLog.create({
        data: {
          actor,
          action: "config.deposit_card",
          subjectId: key,
          detail: "Card payment settings published",
        },
      });
      return;
    }
    default:
      await prisma.adminAuditLog.create({
        data: {
          actor,
          action: `approval.execute.${actionType}`,
          subjectId: userId,
          detail: `Approved action recorded (no executor for ${actionType})`,
          meta: asJson(payload),
        },
      });
  }
}

async function audit(
  actor: string,
  action: string,
  subjectId: string | null,
  detail: string,
  meta?: Record<string, unknown>,
) {
  await prisma.adminAuditLog.create({
    data: { actor, action, subjectId, detail, meta: asJson(meta) },
  });
}

export const adminApprovalsService = {
  async create(actor: { id: string; email: string; name: string; role: string }, input: CreateInput) {
    const cls = input.cls?.trim() || "config";
    if (!APPROVAL_CLASSES.includes(cls as ApprovalClass) && cls.length < 2) {
      throw new AppError("Invalid approval class", 400);
    }
    const title = input.title?.trim();
    const reason = input.reason?.trim();
    if (!title || title.length < 3) throw new AppError("Title required", 400);
    if (!reason || reason.length < 6) throw new AppError("Reason required (min 6 chars)", 400);

    const checks: CheckRow[] = input.checks?.length
      ? input.checks
      : [
          { label: "Requester ≠ approver", ok: true },
          { label: "Within policy window", ok: true },
        ];

    const hours = Math.min(168, Math.max(1, Number(input.expiresInHours ?? 24)));
    const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
    const publicId = await nextPublicId();

    const row = await prisma.adminApprovalRequest.create({
      data: {
        publicId,
        cls,
        title,
        module: input.module?.trim() || "Platform",
        requesterId: actor.id,
        requesterName: actor.name || actor.email,
        requesterEmail: actor.email,
        reason,
        risk: input.risk ?? "medium",
        amount: input.amount,
        subjectId: input.subjectId,
        sourcePath: input.sourcePath || "/admin/platform/approvals",
        diffJson: JSON.stringify(input.diff ?? []),
        checksJson: JSON.stringify(checks),
        effectsJson: input.effects ? JSON.stringify(input.effects) : null,
        actionType: input.actionType,
        actionPayload: input.actionPayload ? JSON.stringify(input.actionPayload) : null,
        status: "pending",
        expiresAt,
      },
    });

    await audit(actor.email, "approval.create", input.subjectId ?? null, `${publicId}: ${title}`, {
      publicId,
      cls,
      actionType: input.actionType,
    });

    return mapRow(row);
  },

  async list(query: { status?: string; cls?: string; limit?: number } = {}) {
    const limit = Math.min(200, Math.max(1, Number(query.limit ?? 100)));
    const where: { status?: string; cls?: string } = {};
    if (query.status && query.status !== "all") where.status = query.status;
    if (query.cls && query.cls !== "all") where.cls = query.cls;

    const rows = await prisma.adminApprovalRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    const mapped = [];
    for (const row of rows) {
      const status = await expireIfNeeded(row.id, row.expiresAt, row.status);
      mapped.push(mapRow({ ...row, status }));
    }
    return mapped;
  },

  async get(publicId: string) {
    const row = await prisma.adminApprovalRequest.findUnique({ where: { publicId } });
    if (!row) throw new NotFoundError("Approval not found");
    const status = await expireIfNeeded(row.id, row.expiresAt, row.status);
    return mapRow({ ...row, status });
  },

  async decide(
    actor: { id: string; email: string; name: string; role: string },
    publicId: string,
    decision: "approved" | "rejected",
    comment?: string,
  ) {
    const row = await prisma.adminApprovalRequest.findUnique({ where: { publicId } });
    if (!row) throw new NotFoundError("Approval not found");

    const status = await expireIfNeeded(row.id, row.expiresAt, row.status);
    if (status === "expired") throw new AppError("This approval request has expired", 400);
    if (status !== "pending") throw new AppError("This approval has already been decided", 400);

    if (row.requesterId === actor.id || row.requesterEmail.toLowerCase() === actor.email.toLowerCase()) {
      throw new ForbiddenError("You cannot counter-sign a request you raised");
    }

    if (decision === "rejected" && (!comment || comment.trim().length < 10)) {
      throw new AppError("A comment of at least 10 characters is required to reject", 400);
    }

    const checks = parseJsonArray<CheckRow>(row.checksJson, []);
    const failing = checks.some((c) => !c.ok);
    if (decision === "approved" && failing && (!comment || comment.trim().length < 10)) {
      throw new AppError("Failing checks require a written override (min 10 characters)", 400);
    }

    if (decision === "approved") {
      await executeAction(row.actionType, parseJsonObject(row.actionPayload), actor.email);
    }

    const updated = await prisma.adminApprovalRequest.update({
      where: { id: row.id },
      data: {
        status: decision,
        decidedById: actor.id,
        decidedByName: actor.name || actor.email,
        decidedAt: new Date(),
        comment: comment?.trim() || null,
      },
    });

    await audit(
      actor.email,
      `approval.${decision}`,
      row.subjectId,
      `${publicId} ${decision}${comment?.trim() ? `: ${comment.trim()}` : ""}`,
      { publicId, requesterId: row.requesterId, actionType: row.actionType },
    );

    return mapRow(updated);
  },
};
