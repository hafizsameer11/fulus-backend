import { env } from "../../config/env.js";
import { ProviderError } from "../../lib/errors.js";
import { providerFetch } from "../../lib/provider-http.js";

/**
 * Strowallet — airtime, data, electricity, cable and other bill payments.
 * Docs: https://strowallet.readme.io/
 */
export class StrowalletClient {
  private ensureConfigured() {
    if (!env.STROWALLET_PUBLIC_KEY && !env.STROWALLET_SECRET_KEY) {
      throw new ProviderError("strowallet", "API keys are not configured");
    }
  }

  private async request<T>(
    path: string,
    options: {
      method?: "GET" | "POST";
      query?: Record<string, string | number | boolean | undefined | null>;
      body?: Record<string, unknown>;
    } = {},
  ) {
    this.ensureConfigured();

    const { status, data } = await providerFetch<T>(env.STROWALLET_BASE_URL, {
      method: options.method ?? "POST",
      path,
      query: {
        public_key: env.STROWALLET_PUBLIC_KEY || undefined,
        secret_key: env.STROWALLET_SECRET_KEY || undefined,
        ...options.query,
      },
      body: options.body,
    });

    if (status >= 400) {
      throw new ProviderError("strowallet", `Request failed with status ${status}`, data);
    }

    return data;
  }

  buyAirtime(input: { amount: number | string; phone: string; service_id: string }) {
    return this.request("/api/buyairtime/", {
      body: {
        public_key: env.STROWALLET_PUBLIC_KEY,
        amount: String(input.amount),
        phone: input.phone,
        service_id: input.service_id,
      },
    });
  }

  buyData(input: {
    amount: number | string;
    phone: string;
    service_id: string;
    variation_code: string;
  }) {
    return this.request("/api/buydata/", {
      body: {
        public_key: env.STROWALLET_PUBLIC_KEY,
        amount: String(input.amount),
        phone: input.phone,
        service_id: input.service_id,
        variation_code: input.variation_code,
      },
    });
  }

  verifyMeter(input: { billersCode: string; serviceID: string; type: "prepaid" | "postpaid" }) {
    return this.request("/api/verify-meter/", {
      body: {
        public_key: env.STROWALLET_PUBLIC_KEY,
        ...input,
      },
    });
  }

  buyElectricity(input: {
    amount: number | string;
    phone: string;
    serviceID: string;
    variation_code: "prepaid" | "postpaid";
    billersCode: string;
  }) {
    return this.request("/api/buyelectricity/", {
      body: {
        public_key: env.STROWALLET_PUBLIC_KEY,
        amount: String(input.amount),
        phone: input.phone,
        serviceID: input.serviceID,
        variation_code: input.variation_code,
        billersCode: input.billersCode,
      },
    });
  }

  buyCable(input: {
    amount: number | string;
    phone: string;
    serviceID: string;
    variation_code: string;
    billersCode: string;
  }) {
    return this.request("/api/buycable/", {
      body: {
        public_key: env.STROWALLET_PUBLIC_KEY,
        amount: String(input.amount),
        phone: input.phone,
        serviceID: input.serviceID,
        variation_code: input.variation_code,
        billersCode: input.billersCode,
      },
    });
  }

  getCheckoutStatus(reference: string) {
    return this.request("/api/checkout/status/", {
      method: "GET",
      query: {
        public_key: env.STROWALLET_PUBLIC_KEY,
        reference,
      },
    });
  }
}

export const strowalletClient = new StrowalletClient();
