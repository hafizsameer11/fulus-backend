import { env } from "../../config/env.js";
import { ProviderError } from "../../lib/errors.js";
import { providerFetch } from "../../lib/provider-http.js";

export type BushaProfileScope = string | null | undefined;
/**
 * profileId:
 * - `undefined` → use env BUSHA_PROFILE_ID when set (legacy default)
 * - `null` → force business/master (omit X-BU-PROFILE-ID)
 * - `string` → that customer / business profile id
 */

/**
 * Busha Business API — customers, currencies, balances, quotes, payments, transfers.
 * Docs: https://docs.busha.io/
 */
export class BushaClient {
  private authHeaders(usePublic = false, profileId?: BushaProfileScope): Record<string, string> {
    if (usePublic) {
      return { "X-BU-PUBLIC-KEY": env.BUSHA_PUBLIC_KEY };
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${env.BUSHA_SECRET_KEY}`,
    };

    if (profileId === null) {
      // Master / business float — do not attach a customer profile.
    } else if (typeof profileId === "string" && profileId.trim()) {
      headers["X-BU-PROFILE-ID"] = profileId.trim();
    } else if (env.BUSHA_PROFILE_ID) {
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
      /** undefined = env default; null = master; string = that profile */
      profileId?: BushaProfileScope;
    } = {},
  ) {
    const key = options.usePublic ? env.BUSHA_PUBLIC_KEY : env.BUSHA_SECRET_KEY;
    if (!key) {
      throw new ProviderError("busha", "API key is not configured");
    }

    const headers = this.authHeaders(options.usePublic, options.profileId);

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

  /** Business (master) balances — never attach customer profile. */
  listMasterBalances() {
    return this.request("/v1/balances", { profileId: null });
  }

  listBalances(customerId?: string | null) {
    return this.request("/v1/balances", {
      profileId: customerId === undefined ? undefined : customerId,
    });
  }

  listCurrencies(query?: { type?: string }) {
    return this.request("/v1/currencies", {
      query: query?.type ? { type: query.type } : undefined,
      profileId: null,
    });
  }

  createCustomer(body: Record<string, unknown>) {
    return this.request("/v1/customers", { method: "POST", body, profileId: null });
  }

  updateCustomer(customerId: string, body: Record<string, unknown>) {
    return this.request(`/v1/customers/${customerId}`, { method: "PUT", body, profileId: null });
  }

  getCustomer(customerId: string) {
    return this.request(`/v1/customers/${customerId}`, { profileId: null });
  }

  verifyCustomer(customerId: string) {
    return this.request(`/v1/customers/${customerId}/verify`, { method: "POST", body: {}, profileId: null });
  }

  createPayment(body: Record<string, unknown>, customerId?: string) {
    return this.request("/v1/payments", {
      method: "POST",
      body,
      usePublic: true,
      profileId: customerId ?? null,
    });
  }

  getRates(query?: Record<string, string>) {
    return this.request("/v1/rates", { query, profileId: null });
  }

  listPairs(query?: { id?: string; type?: string; currency?: string; counter?: string; base?: string }) {
    return this.request("/v1/pairs", {
      profileId: null,
      query: {
        id: query?.id,
        type: query?.type,
        currency: query?.currency,
        counter: query?.counter,
        base: query?.base,
      },
    });
  }

  createQuote(body: Record<string, unknown>, profileId?: BushaProfileScope) {
    return this.request("/v1/quotes", { method: "POST", body, profileId });
  }

  createTransfer(body: Record<string, unknown>, profileId?: BushaProfileScope) {
    return this.request("/v1/transfers", { method: "POST", body, profileId });
  }

  getTransfer(transferId: string, profileId?: BushaProfileScope) {
    return this.request(`/v1/transfers/${encodeURIComponent(transferId)}`, { profileId });
  }

  getDepositAddress(code: string, customerId?: string, network?: string) {
    return this.request(`/v1/addresses/${encodeURIComponent(code)}`, {
      profileId: customerId,
      query: network ? { network } : undefined,
    });
  }

  createRecipient(body: Record<string, unknown>, profileId?: BushaProfileScope) {
    return this.request("/v1/recipients", { method: "POST", body, profileId: profileId ?? null });
  }

  listRecipients(query?: { currency?: string }, profileId?: BushaProfileScope) {
    return this.request("/v1/recipients", {
      profileId: profileId ?? null,
      query: query?.currency ? { currency: query.currency } : undefined,
    });
  }

  deleteRecipient(recipientId: string, profileId?: BushaProfileScope) {
    return this.request(`/v1/recipients/${encodeURIComponent(recipientId)}`, {
      method: "DELETE",
      profileId: profileId ?? null,
    });
  }

  getVirtualBankAccount(code: string) {
    return this.request(`/v1/virtual_bank_accounts/${encodeURIComponent(code)}`, { profileId: null });
  }
}

export const bushaClient = new BushaClient();
