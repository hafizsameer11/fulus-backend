import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";
import { ProviderError } from "../../lib/errors.js";
import { providerFetch } from "../../lib/provider-http.js";

/**
 * eSIM Go API v2.5 — catalogue, orders, assignments, usage.
 * Docs: https://docs.esim-go.com/
 */
export class EsimGoClient {
  private headers(extra?: Record<string, string>) {
    return {
      "X-API-Key": env.ESIM_GO_API_KEY,
      ...extra,
    };
  }

  private async request<T>(
    path: string,
    options: {
      method?: "GET" | "POST";
      body?: unknown;
      query?: Record<string, string | number | boolean | undefined | null>;
      accept?: string;
    } = {},
  ) {
    if (!env.ESIM_GO_API_KEY) {
      throw new ProviderError("esim-go", "API key is not configured");
    }

    const { status, data } = await providerFetch<T>(env.ESIM_GO_BASE_URL, {
      method: options.method ?? "GET",
      path,
      body: options.body,
      query: options.query,
      headers: this.headers(options.accept ? { Accept: options.accept } : undefined),
    });

    if (status >= 400) {
      throw new ProviderError("esim-go", `Request failed with status ${status}`, data);
    }

    return data;
  }

  getCatalogue(query?: Record<string, string | number>) {
    return this.request("/catalogue", { query });
  }

  getCatalogueBundle(name: string) {
    return this.request(`/catalogue/bundle/${encodeURIComponent(name)}`);
  }

  /**
   * OpenAPI body shape: { type, assign?, order: [{ type: "bundle", item, quantity, iccids? }] }
   * Quick-start also documents a flat { type, item, quantity, assign, iccid } form — we use OpenAPI.
   */
  private orderBody(input: {
    type: "validate" | "transaction";
    item: string;
    quantity?: number;
    assign?: boolean;
    iccid?: string;
    allowReassign?: boolean;
  }) {
    const line: Record<string, unknown> = {
      type: "bundle",
      quantity: input.quantity ?? 1,
      item: input.item,
      allowReassign: input.allowReassign ?? Boolean(input.iccid),
    };
    if (input.iccid?.trim()) {
      line.iccids = [input.iccid.trim()];
    }
    return {
      type: input.type,
      assign: input.assign ?? true,
      order: [line],
    };
  }

  validateOrder(input: { item: string; quantity?: number }) {
    return this.request("/orders", {
      method: "POST",
      body: this.orderBody({
        type: "validate",
        item: input.item,
        quantity: input.quantity,
        assign: true,
      }),
    });
  }

  createOrder(input: {
    item: string;
    quantity?: number;
    assign?: boolean;
    iccid?: string;
    allowReassign?: boolean;
  }) {
    return this.request("/orders", {
      method: "POST",
      body: this.orderBody({
        type: "transaction",
        item: input.item,
        quantity: input.quantity,
        assign: input.assign ?? true,
        iccid: input.iccid,
        allowReassign: input.allowReassign ?? true,
      }),
    });
  }

  /** GET /esims/assignments — query `reference` (order / apply reference). */
  getAssignments(reference: string) {
    return this.request("/esims/assignments", {
      query: { reference, orderReference: reference },
      accept: "application/json",
    });
  }

  getBundleStatus(iccid: string, name: string) {
    return this.request(`/esims/${encodeURIComponent(iccid)}/bundles/${encodeURIComponent(name)}`);
  }

  /**
   * V3 callbacks: HMAC-SHA256 of raw body, digest as base64 in X-Signature-SHA256.
   * Also accept hex digests for older samples.
   */
  verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined) {
    if (!env.ESIM_GO_API_KEY) return true;
    if (!signatureHeader?.trim()) return false;

    const raw = Buffer.from(rawBody, "utf8");
    const base64 = createHmac("sha256", env.ESIM_GO_API_KEY).update(raw).digest("base64");
    const hex = createHmac("sha256", env.ESIM_GO_API_KEY).update(raw).digest("hex");
    const incoming = signatureHeader.trim();

    return safeEqual(incoming, base64) || safeEqual(incoming.toLowerCase(), hex.toLowerCase());
  }
}

function safeEqual(a: string, b: string) {
  try {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export const esimGoClient = new EsimGoClient();
