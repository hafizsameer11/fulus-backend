import { env } from "../../config/env.js";
import { ProviderError } from "../../lib/errors.js";
import { providerFetch } from "../../lib/provider-http.js";

/**
 * Busha Business API — crypto balances, quotes, payments, transfers.
 * Docs: https://docs.busha.co/
 */
export class BushaClient {
  private authHeaders(usePublic = false): Record<string, string> {
    if (usePublic) {
      return { "X-BU-PUBLIC-KEY": env.BUSHA_PUBLIC_KEY };
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${env.BUSHA_SECRET_KEY}`,
    };
    if (env.BUSHA_PROFILE_ID) {
      headers["X-BU-PROFILE-ID"] = env.BUSHA_PROFILE_ID;
    }
    return headers;
  }

  private async request<T>(
    path: string,
    options: {
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      body?: unknown;
      query?: Record<string, string | number | boolean | undefined | null>;
      usePublic?: boolean;
    } = {},
  ) {
    const key = options.usePublic ? env.BUSHA_PUBLIC_KEY : env.BUSHA_SECRET_KEY;
    if (!key) {
      throw new ProviderError("busha", "API key is not configured");
    }

    const { status, data } = await providerFetch<T>(env.BUSHA_BASE_URL, {
      method: options.method ?? "GET",
      path,
      body: options.body,
      query: options.query,
      headers: this.authHeaders(options.usePublic),
    });

    if (status >= 400) {
      throw new ProviderError("busha", `Request failed with status ${status}`, data);
    }

    return data;
  }

  listBalances() {
    return this.request("/v1/balances");
  }

  createPayment(body: Record<string, unknown>) {
    return this.request("/v1/payments", { method: "POST", body, usePublic: true });
  }

  getRates(query?: Record<string, string>) {
    return this.request("/v1/rates", { query });
  }

  createQuote(body: Record<string, unknown>) {
    return this.request("/v1/quotes", { method: "POST", body });
  }

  createTransfer(body: Record<string, unknown>) {
    return this.request("/v1/transfers", { method: "POST", body });
  }
}

export const bushaClient = new BushaClient();
