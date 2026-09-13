export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Unwrap Pagocards envelopes: `{ data: {...} }` or `{ data: { card: {...} } }`. */
export function pagoPayloadData(payload: unknown): Record<string, unknown> {
  const root = asRecord(payload);
  if (!root) return {};
  const data = asRecord(root.data) ?? root;
  const nestedCard = asRecord(data.card) ?? asRecord(data.Card);
  return nestedCard ? { ...data, ...nestedCard } : data;
}

/** Accept string or number fields (Pagocards sometimes returns numeric CVV / last4). */
export function pickPagoString(obj: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim() && value.trim().toLowerCase() !== "null") {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
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

export function extractPagoCardSecrets(raw: unknown) {
  const data = pagoPayloadData(raw);
  const pan = pickPagoString(data, ["card_number", "cardnumber", "pan", "cardNumber", "number"]);
  const cvv = pickPagoString(data, ["cvv", "cvc", "security_code"]);
  const expiredate = pickPagoString(data, ["expiredate", "expire_date", "expiry", "expiration"]);
  let expMonth = Number(data.expiry_month ?? data.exp_month ?? data.expiryMonth);
  let expYear = Number(data.expiry_year ?? data.exp_year ?? data.expiryYear);
  if (expiredate) {
    const m = expiredate.match(/^(\d{1,2})\s*\/\s*(\d{2,4})$/);
    if (m) {
      expMonth = Number(m[1]);
      const yy = Number(m[2]);
      expYear = yy < 100 ? 2000 + yy : yy;
    }
  }
  const last4 =
    pickPagoString(data, ["last_four", "lastfour", "last4", "last_4"]) ??
    (pan && pan.replace(/\D/g, "").length >= 4 ? pan.replace(/\D/g, "").slice(-4) : undefined);

  return {
    data,
    pan,
    cvv,
    expiredate:
      expiredate ??
      (Number.isFinite(expMonth) && Number.isFinite(expYear) && expMonth >= 1 && expMonth <= 12
        ? `${String(expMonth).padStart(2, "0")}/${String(expYear).slice(-2)}`
        : undefined),
    last4,
    expMonth: Number.isFinite(expMonth) && expMonth >= 1 && expMonth <= 12 ? expMonth : undefined,
    expYear: Number.isFinite(expYear) && expYear > 2000 ? expYear : undefined,
    balance: pagoDisplayBalance(data),
    providerStatus: pickPagoString(data, ["status"]),
  };
}
