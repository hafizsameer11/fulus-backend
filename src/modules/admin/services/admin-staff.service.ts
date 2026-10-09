import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { ConflictError, ForbiddenError, NotFoundError, AppError } from "../../../lib/errors.js";
import { prisma } from "../../../lib/prisma.js";
import { ADMIN_ROLES, canManageStaff, isAdminRole, type AdminRole } from "../lib/roles.js";

function staffSelect() {
  return {
    id: true,
    email: true,
    name: true,
    role: true,
    active: true,
    totpEnabled: true,
    totpEnrolledAt: true,
    totpLastUsedAt: true,
    createdAt: true,
    updatedAt: true,
  } as const;
}

function mapStaff(s: {
  id: string;
  email: string;
  name: string;
  role: string;
  active: boolean;
  totpEnabled: boolean;
  totpEnrolledAt: Date | null;
  totpLastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: s.id,
    email: s.email,
    name: s.name,
    role: s.role,
    active: s.active,
    mfaEnabled: s.totpEnabled,
    mfaEnrolledAt: s.totpEnrolledAt?.toISOString() ?? null,
    mfaLastUsedAt: s.totpLastUsedAt?.toISOString() ?? null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

async function audit(actor: string, action: string, staffId: string | null, detail: string) {
  // subjectId FK points at consumer User — keep null for staff IAM; store staff id in meta
  await prisma.adminAuditLog.create({
    data: {
      actor,
      action,
      subjectId: null,
      detail,
      meta: staffId ? { staffId } : undefined,
    },
  });
}

function genTempPassword() {
  // 16 chars, URL-safe — shown once to the inviter
  return randomBytes(12).toString("base64url");
}

export const adminStaffService = {
  roles: ADMIN_ROLES,

  async list() {
    const staff = await prisma.adminUser.findMany({
      orderBy: { createdAt: "desc" },
      select: staffSelect(),
    });
    return staff.map(mapStaff);
  },

  async create(
    actor: { id: string; email: string; role: string },
    input: { email: string; name: string; role: string; password?: string },
  ) {
    if (!canManageStaff(actor.role)) {
      throw new ForbiddenError("Only Security / Platform Admin can invite staff");
    }

    const email = input.email.trim().toLowerCase();
    const name = input.name.trim();
    if (!email || !email.includes("@")) throw new AppError("Valid work email is required", 400);
    if (name.length < 2) throw new AppError("Name is required", 400);
    if (!isAdminRole(input.role)) {
      throw new AppError(`Invalid role. Allowed: ${ADMIN_ROLES.join(", ")}`, 400);
    }

    const existing = await prisma.adminUser.findUnique({ where: { email } });
    if (existing) throw new ConflictError("An admin with this email already exists");

    const tempPassword = input.password?.trim() || genTempPassword();
    if (tempPassword.length < 10) throw new AppError("Password must be at least 10 characters", 400);

    const row = await prisma.adminUser.create({
      data: {
        email,
        name,
        role: input.role as AdminRole,
        passwordHash: await bcrypt.hash(tempPassword, 12),
        active: true,
      },
      select: staffSelect(),
    });

    await audit(
      actor.email,
      "staff.invite",
      row.id,
      `Invited ${email} as ${input.role}`,
    );

    return { staff: mapStaff(row), temporaryPassword: tempPassword };
  },

  async update(
    actor: { id: string; email: string; role: string },
    id: string,
    input: { role?: string; name?: string; active?: boolean; password?: string },
  ) {
    if (!canManageStaff(actor.role)) {
      throw new ForbiddenError("Only Security / Platform Admin can update staff");
    }

    const target = await prisma.adminUser.findUnique({ where: { id } });
    if (!target) throw new NotFoundError("Staff account not found");

    const data: {
      role?: string;
      name?: string;
      active?: boolean;
      passwordHash?: string;
    } = {};

    if (input.role !== undefined) {
      if (!isAdminRole(input.role)) {
        throw new AppError(`Invalid role. Allowed: ${ADMIN_ROLES.join(", ")}`, 400);
      }
      if (target.id === actor.id && input.role !== "super_admin") {
        throw new AppError("You cannot remove your own super_admin role", 400);
      }
      data.role = input.role;
    }
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length < 2) throw new AppError("Name is required", 400);
      data.name = name;
    }
    if (input.active !== undefined) {
      if (target.id === actor.id && input.active === false) {
        throw new AppError("You cannot deactivate your own account", 400);
      }
      data.active = input.active;
    }
    if (input.password !== undefined) {
      if (input.password.length < 10) throw new AppError("Password must be at least 10 characters", 400);
      data.passwordHash = await bcrypt.hash(input.password, 12);
    }

    if (!Object.keys(data).length) throw new AppError("No changes provided", 400);

    // Keep at least one active super_admin
    if (data.role && data.role !== "super_admin" && target.role === "super_admin") {
      const others = await prisma.adminUser.count({
        where: { role: "super_admin", active: true, id: { not: id } },
      });
      if (others === 0) throw new AppError("Cannot demote the last active super_admin", 400);
    }
    if (data.active === false && target.role === "super_admin") {
      const others = await prisma.adminUser.count({
        where: { role: "super_admin", active: true, id: { not: id } },
      });
      if (others === 0) throw new AppError("Cannot deactivate the last active super_admin", 400);
    }

    const row = await prisma.adminUser.update({
      where: { id },
      data,
      select: staffSelect(),
    });

    await audit(
      actor.email,
      "staff.update",
      id,
      `Updated ${target.email}: ${Object.keys(data).join(", ")}`,
    );

    return mapStaff(row);
  },

  async offboard(actor: { id: string; email: string; role: string }, id: string) {
    if (!canManageStaff(actor.role)) {
      throw new ForbiddenError("Only Security / Platform Admin can offboard staff");
    }
    const target = await prisma.adminUser.findUnique({ where: { id } });
    if (!target) throw new NotFoundError("Staff account not found");
    if (target.id === actor.id) throw new AppError("You cannot offboard yourself", 400);

    if (target.role === "super_admin") {
      const others = await prisma.adminUser.count({
        where: { role: "super_admin", active: true, id: { not: id } },
      });
      if (others === 0) throw new AppError("Cannot offboard the last active super_admin", 400);
    }

    const row = await prisma.adminUser.update({
      where: { id },
      data: {
        active: false,
        totpEnabled: false,
        totpSecret: null,
        totpPendingSecret: null,
        totpBackupHashes: null,
      },
      select: staffSelect(),
    });

    await audit(actor.email, "staff.offboard", id, `Offboarded ${target.email}`);
    return mapStaff(row);
  },
};
