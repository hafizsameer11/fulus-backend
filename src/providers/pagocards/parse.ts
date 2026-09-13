export function pagoPayloadData(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  const root = payload as Record<string, unknown>;
  if (root.data && typeof root.data === "object" && !Array.isArray(root.data)) {
    return root.data as Record<string, unknown>;
  }
  return root;
}

export function pickPagoString(obj: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function pagoDisplayBalance(data: Record<string, unknown>): number {
  const balance = data.balance;
  if (balance && typeof balance === "object") {
    const b = balance as Record<string, unknown>;
    const display = Number(b.display_amount);
    if (Number.isFinite(display)) return display;
  }
  const displayTop = Number(data.display_amount);
  if (Number.isFinite(displayTop)) return displayTop;
  const raw = Number(data.balance);
  return Number.isFinite(raw) ? raw : 0;
}
