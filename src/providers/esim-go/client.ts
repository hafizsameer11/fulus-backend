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

  validateOrder(input: { item: string; quantity?: number }) {
    return this.request("/orders", {
      method: "POST",
      body: {
        type: "validate",
        quantity: input.quantity ?? 1,
        item: input.item,
      },
    });
  }

  createOrder(input: {
    item: string;
    quantity?: number;
    assign?: boolean;
    iccid?: string;
  }) {
    return this.request("/orders", {
      method: "POST",
      body: {
        type: "transaction",
        quantity: input.quantity ?? 1,
        item: input.item,
        assign: input.assign ?? true,
        iccid: input.iccid ?? "",
      },
    });
  }

  getAssignments(orderReference: string) {
    return this.request("/esims/assignments", {
      query: { orderReference },
      accept: "application/json",
    });
  }

  getBundleStatus(iccid: string, name: string) {
    return this.request(`/esims/${encodeURIComponent(iccid)}/bundles/${encodeURIComponent(name)}`);
  }

  verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined) {
    if (!signatureHeader || !env.ESIM_GO_API_KEY) return false;
    const digest = createHmac("sha256", env.ESIM_GO_API_KEY).update(rawBody).digest("hex");
    const a = Buffer.from(digest);
    const b = Buffer.from(signatureHeader);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

export const esimGoClient = new EsimGoClient();
