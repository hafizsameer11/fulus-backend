import { env } from "../../config/env.js";
import { ProviderError } from "../../lib/errors.js";
import { providerFetch } from "../../lib/provider-http.js";

/**
 * Pagocards Visa card issuing (BIN 43xx virtual Visa).
 * Docs: https://pagocards.com/documentation
 */
export class PagocardsClient {
  private headers() {
    return {
      publickey: env.PAGOCARDS_PUBLIC_KEY,
      secretkey: env.PAGOCARDS_SECRET_KEY,
    };
  }

  private async request<T>(path: string, body?: Record<string, unknown>, method: "GET" | "POST" | "PUT" = "POST") {
    if (!env.PAGOCARDS_PUBLIC_KEY || !env.PAGOCARDS_SECRET_KEY) {
      throw new ProviderError("pagocards", "API keys are not configured");
    }

    const { status, data } = await providerFetch<T>(env.PAGOCARDS_BASE_URL, {
      method,
      path,
      body,
      headers: this.headers(),
    });

    if (status >= 400) {
      throw new ProviderError("pagocards", `Request failed with status ${status}`, data);
    }

    return data;
  }

  createVisaCard(input: { firstname: string; lastname: string; email: string }) {
    return this.request("/api/visacard/createcard", input);
  }

  fundVisaCard(input: { cardid: string; email: string; amount: number }) {
    return this.request("/api/visacard/fundcard", input);
  }

  getVisaCard(input: { cardid: string; email: string }) {
    return this.request("/api/visacard/getcard", input);
  }

  listVisaCards(input: { email: string }) {
    return this.request("/api/visacard/getallcards", input);
  }

  blockVisaCard(input: { cardid: string; email: string }) {
    return this.request("/api/visacard/blockcard", input);
  }

  unblockVisaCard(input: { cardid: string; email: string }) {
    return this.request("/api/visacard/unblockcard", input);
  }

  terminateCard(input: { cardid: string; email: string }) {
    return this.request("/api/terminate", input);
  }

  setSpendControls(input: Record<string, unknown>) {
    return this.request("/api/visacard/spendcontrols", input, "PUT");
  }
}

export const pagocardsClient = new PagocardsClient();
