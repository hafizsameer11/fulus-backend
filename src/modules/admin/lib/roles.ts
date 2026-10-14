/** Canonical console roles — keep in sync with fulpadmin `RoleKey`. */
export const ADMIN_ROLES = [
  "super_admin",
  "support_agent",
  "support_lead",
  "compliance",
  "payment_ops",
  "finance",
  "growth",
  "product_admin",
  "auditor",
] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

/** Module roots matching fulpadmin `ROLE_MODULES` / nav. */
export const ROLE_MODULES: Record<AdminRole, string[] | "*"> = {
  super_admin: "*",
  auditor: "*",
  support_agent: ["/admin", "/admin/customers", "/admin/money", "/admin/cards", "/admin/bills", "/admin/support"],
  support_lead: [
    "/admin",
    "/admin/customers",
    "/admin/money",
    "/admin/cards",
    "/admin/crypto",
    "/admin/bills",
    "/admin/support",
    "/admin/analytics",
    "/admin/platform",
  ],
  compliance: [
    "/admin",
    "/admin/customers",
    "/admin/money",
    "/admin/compliance",
    "/admin/support",
    "/admin/analytics",
    "/admin/platform",
  ],
  payment_ops: [
    "/admin",
    "/admin/money",
    "/admin/cards",
    "/admin/crypto",
    "/admin/bills",
    "/admin/finance",
    "/admin/platform",
    "/admin/analytics",
  ],
  finance: ["/admin", "/admin/money", "/admin/finance", "/admin/crypto", "/admin/analytics", "/admin/platform"],
  growth: ["/admin", "/admin/customers", "/admin/engagement", "/admin/analytics"],
  product_admin: ["/admin", "/admin/config", "/admin/bills", "/admin/cards", "/admin/crypto", "/admin/analytics"],
};

/** Map first path segment under `/admin/...` → module root used for RBAC. */
const RESOURCE_MODULE: Record<string, string> = {
  auth: "/admin",
  overview: "/admin",
  users: "/admin/customers",
  devices: "/admin/customers",
  segments: "/admin/customers",
  beneficiaries: "/admin/customers",
  transactions: "/admin/money",
  deposits: "/admin/money",
  payouts: "/admin/money",
  "card-payments": "/admin/money",
  disputes: "/admin/money",
  refunds: "/admin/money",
  swaps: "/admin/money",
  ledger: "/admin/money",
  "payout-batches": "/admin/money",
  "bank-statements": "/admin/money",
  cards: "/admin/cards",
  "card-programs": "/admin/cards",
  "card-authorisations": "/admin/cards",
  crypto: "/admin/crypto",
  "crypto-assets": "/admin/crypto",
  "crypto-orders": "/admin/crypto",
  bills: "/admin/bills",
  billers: "/admin/bills",
  esim: "/admin/bills",
  kyc: "/admin/compliance",
  aml: "/admin/compliance",
  sanctions: "/admin/compliance",
  cases: "/admin/compliance",
  fx: "/admin/finance",
  float: "/admin/finance",
  treasury: "/admin/finance",
  reconciliation: "/admin/finance",
  revenue: "/admin/finance",
  invoices: "/admin/finance",
  engagement: "/admin/engagement",
  inbox: "/admin/engagement",
  campaigns: "/admin/engagement",
  referrals: "/admin/engagement",
  support: "/admin/support",
  "platform-config": "/admin/config",
  config: "/admin/config",
  analytics: "/admin/analytics",
  staff: "/admin/platform",
  "kill-switches": "/admin/platform",
  audit: "/admin/platform",
  webhooks: "/admin/platform",
  providers: "/admin/platform",
  /** Any signed-in staff can raise / counter-sign (self-approve blocked in service). */
  approvals: "/admin",
  closures: "/admin/platform",
};

export function isAdminRole(role: string): role is AdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(role);
}

export function normalizeAdminRole(role: string | null | undefined): AdminRole {
  if (role && isAdminRole(role)) return role;
  return "support_agent";
}

export function canAccessModule(role: string, modulePath: string): boolean {
  const r = normalizeAdminRole(role);
  const allowed = ROLE_MODULES[r];
  if (allowed === "*") return true;
  return allowed.includes(modulePath);
}

/** Resolve RBAC module for an Express path (with or without `/api/v1`). */
export function moduleForAdminPath(pathname: string): string {
  const cleaned = pathname.replace(/^\/api\/v1/, "").split("?")[0] ?? "";
  const parts = cleaned.split("/").filter(Boolean);
  if (parts[0] !== "admin") return "/admin";
  const resource = parts[1] ?? "";
  if (!resource) return "/admin";
  return RESOURCE_MODULE[resource] ?? "/admin";
}

/** Staff IAM mutations — invite, role change, offboard. */
export function canManageStaff(role: string): boolean {
  return normalizeAdminRole(role) === "super_admin";
}
