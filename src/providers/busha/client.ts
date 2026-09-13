import { env } from "../../config/env.js";
import { ProviderError } from "../../lib/errors.js";
import { providerFetch } from "../../lib/provider-http.js";

/**
 * Busha Business API — customers, currencies, balances, quotes, payments, transfers.
 * Docs: https://docs.busha.io/
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
      profileId?: string;
    } = {},
  ) {
    const key = options.usePublic ? env.BUSHA_PUBLIC_KEY : env.BUSHA_SECRET_KEY;
    if (!key) {
      throw new ProviderError("busha", "API key is not configured");
    }

    const headers = this.authHeaders(options.usePublic);
    if (options.profileId) {
      headers["X-BU-PROFILE-ID"] = options.profileId;
    }

    const { status, data } = await providerFetch<T>(env.BUSHA_BASE_URL, {
      method: options.method ?? "GET",
      path,
      body: options.body,
      query: options.query,
      headers,
    });

    if (status >= 400) {
      throw new ProviderError("busha", `Request failed with status ${status}`, data);
    }

    return data;
  }

  listBalances(customerId?: string) {
    return this.request("/v1/balances", {
      profileId: customerId,
    });
  }

  listCurrencies(query?: { type?: string }) {
    return this.request("/v1/currencies", {
      query: query?.type ? { type: query.type } : undefined,
    });
  }

  createCustomer(body: Record<string, unknown>) {
    return this.request("/v1/customers", { method: "POST", body });
  }

  updateCustomer(customerId: string, body: Record<string, unknown>) {
    return this.request(`/v1/customers/${customerId}`, { method: "PUT", body });
  }

  getCustomer(customerId: string) {
    return this.request(`/v1/customers/${customerId}`);
  }

  verifyCustomer(customerId: string) {
    return this.request(`/v1/customers/${customerId}/verify`, { method: "POST", body: {} });
  }

  createPayment(body: Record<string, unknown>, customerId?: string) {
    return this.request("/v1/payments", { method: "POST", body, usePublic: true, profileId: customerId });
  }

  getRates(query?: Record<string, string>) {
    return this.request("/v1/rates", { query });
  }

  createQuote(body: Record<string, unknown>, customerId?: string) {
    return this.request("/v1/quotes", { method: "POST", body, profileId: customerId });
  }

  createTransfer(body: Record<string, unknown>, customerId?: string) {
    return this.request("/v1/transfers", { method: "POST", body, profileId: customerId });
  }

  getTransfer(transferId: string, customerId?: string) {
    return this.request(`/v1/transfers/${encodeURIComponent(transferId)}`, { profileId: customerId });
  }

  /** GET /v1/addresses/{code} — persistent deposit address for a currency. */
  getDepositAddress(code: string, customerId?: string, network?: string) {
    return this.request(`/v1/addresses/${encodeURIComponent(code)}`, {
      profileId: customerId,
      query: network ? { network } : undefined,
    });
  }
}

export const bushaClient = new BushaClient();
