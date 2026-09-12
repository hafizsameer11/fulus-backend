import { env } from "../../config/env.js";
import { ProviderError } from "../../lib/errors.js";
import { providerFetch } from "../../lib/provider-http.js";

/**
 * Strowallet — airtime, data, electricity, cable and other bill payments.
 * Docs: https://strowallet.readme.io/
 *
 * Official paths use `/request` (and `/plans`, `/verify-merchant`) under each product.
 * Airtime uses `service_name` (mtn | glo | airtel | etisalat).
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
      query: options.query,
      body: options.body,
    });

    if (status >= 400) {
      throw new ProviderError("strowallet", `Request failed with status ${status}`, data);
    }

    // Many Strowallet bill endpoints return HTTP 200 with success:false
    if (
      data &&
      typeof data === "object" &&
      "success" in data &&
      (data as { success?: boolean }).success === false
    ) {
      const msg = (data as { message?: unknown }).message;
      const message = typeof msg === "string" ? msg : "Strowallet request failed";
      throw new ProviderError("strowallet", message, data);
    }

    return data;
  }

  /** Docs: POST /api/buyairtime/request — service_name: mtn, glo, airtel, etisalat */
  buyAirtime(input: { amount: number | string; phone: string; service_name: string }) {
    return this.request("/api/buyairtime/request", {
      body: {
        public_key: env.STROWALLET_PUBLIC_KEY,
        amount: String(input.amount),
        phone: input.phone,
        service_name: input.service_name,
      },
    });
  }

  /** Docs: GET /api/buydata/plans?public_key&service_name */
  getDataPlans(serviceName: string) {
    return this.request("/api/buydata/plans", {
      method: "GET",
      query: {
        public_key: env.STROWALLET_PUBLIC_KEY,
        service_name: serviceName,
      },
    });
  }

  /** Docs: POST /api/buydata/request */
  buyData(input: {
    amount: number | string;
    phone: string;
    service_id: string;
    variation_code: string;
    service_name?: string;
  }) {
    return this.request("/api/buydata/request", {
      body: {
        public_key: env.STROWALLET_PUBLIC_KEY,
        amount: String(input.amount),
        phone: input.phone,
        service_id: input.service_id,
        variation_code: input.variation_code,
        ...(input.service_name ? { service_name: input.service_name } : {}),
      },
    });
  }

  /** Docs: POST /api/electricity/verify-merchant */
  verifyMeter(input: {
    meter_number: string;
    service_name: string;
    meter_type: "prepaid" | "postpaid";
  }) {
    return this.request("/api/electricity/verify-merchant", {
      body: {
        public_key: env.STROWALLET_PUBLIC_KEY,
        meter_number: input.meter_number,
        service_name: input.service_name,
        meter_type: input.meter_type,
      },
    });
  }

  /** Docs: POST /api/electricity/request */
  buyElectricity(input: {
    amount: number | string;
    phone: string;
    service_name: string;
    meter_number: string;
    meter_type: "prepaid" | "postpaid";
  }) {
    return this.request("/api/electricity/request", {
      body: {
        public_key: env.STROWALLET_PUBLIC_KEY,
        amount: String(input.amount),
        phone: input.phone,
        service_name: input.service_name,
        meter_number: input.meter_number,
        meter_type: input.meter_type,
      },
    });
  }

  /** Docs: GET /api/cable-subscription/plans */
  getCablePlans(serviceId: string) {
    return this.request("/api/cable-subscription/plans", {
      method: "GET",
      query: {
        public_key: env.STROWALLET_PUBLIC_KEY,
        service_id: serviceId,
      },
    });
  }

  /** Docs: POST /api/cable-subscription/request */
  buyCable(input: {
    amount: number | string;
    phone: string;
    service_id: string;
    variation_code: string;
    customer_id: string;
    service_name?: string;
  }) {
    return this.request("/api/cable-subscription/request", {
      body: {
        public_key: env.STROWALLET_PUBLIC_KEY,
        amount: String(input.amount),
        phone: input.phone,
        service_id: input.service_id,
        variation_code: input.variation_code,
        customer_id: input.customer_id,
        ...(input.service_name ? { service_name: input.service_name } : {}),
      },
    });
  }

  /** Docs: POST /api/educational/request — WAEC result checker */
  buyEducational(input: {
    amount: number | string;
    phone: string;
    service_name?: string;
    variation_code?: string;
  }) {
    return this.request("/api/educational/request", {
      body: {
        public_key: env.STROWALLET_PUBLIC_KEY,
        amount: String(input.amount),
        phone: input.phone,
        service_name: input.service_name ?? "waec",
        variation_code: input.variation_code ?? "waecdirect",
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

  /**
   * Docs (bank transfer webhook): verify with
   * GET /api/VerifyWebHookTranfer?public_key&merchantTxRef
   */
  verifyWebhookTransfer(merchantTxRef: string) {
    return this.request("/api/VerifyWebHookTranfer", {
      method: "GET",
      query: {
        public_key: env.STROWALLET_PUBLIC_KEY,
        merchantTxRef,
      },
    });
  }
}

export const strowalletClient = new StrowalletClient();
