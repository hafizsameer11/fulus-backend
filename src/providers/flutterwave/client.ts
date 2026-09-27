import { env } from "../../config/env.js";
import { ProviderError } from "../../lib/errors.js";
import { providerFetch } from "../../lib/provider-http.js";
import { useFlutterwaveLive } from "../../lib/simulate.js";

/**
 * Flutterwave v3 Standard Checkout — hosted card payment page for wallet deposits.
 * Docs: https://developer.flutterwave.com/docs/collecting-payments/standard
 */
export class FlutterwaveClient {
  private async request<T>(
    path: string,
    options: {
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      body?: unknown;
      query?: Record<string, string | number | boolean | undefined | null>;
    } = {},
  ) {
    if (!env.FLUTTERWAVE_SECRET_KEY) {
      throw new ProviderError("flutterwave", "API key is not configured");
    }

    const { status, data } = await providerFetch<T>(env.FLUTTERWAVE_BASE_URL, {
      method: options.method ?? "GET",
      path,
      body: options.body,
      query: options.query,
      headers: {
        Authorization: `Bearer ${env.FLUTTERWAVE_SECRET_KEY}`,
      },
    });

    if (status >= 400) {
      throw new ProviderError("flutterwave", `Request failed with status ${status}`, data);
    }

    return data;
  }

  createPayment(body: {
    tx_ref: string;
    amount: number;
    currency: string;
    redirect_url: string;
    customer: { email: string; name?: string; phonenumber?: string };
    meta?: Record<string, unknown>;
    payment_options?: string;
    customizations?: { title?: string; description?: string; logo?: string };
  }) {
    return this.request<{
      status: string;
      message: string;
      data?: { link?: string; status?: string };
    }>("/v3/payments", {
      method: "POST",
      body: {
        ...body,
        payment_options: body.payment_options ?? "card",
        customizations: {
          title: "Fulus",
          description: "Wallet deposit",
          ...body.customizations,
        },
      },
    });
  }

  verifyTransaction(idOrRef: { id?: string | number; tx_ref?: string }) {
    if (idOrRef.id != null) {
      return this.request<{
        status: string;
        message: string;
        data?: Record<string, unknown>;
      }>(`/v3/transactions/${idOrRef.id}/verify`);
    }
    return this.request<{
      status: string;
      message: string;
      data?: Record<string, unknown>;
    }>("/v3/transactions/verify_by_reference", {
      query: { tx_ref: idOrRef.tx_ref },
    });
  }

  /** Flutterwave sends `verif-hash` header equal to FLUTTERWAVE_WEBHOOK_SECRET when configured. */
  verifyWebhookSignature(verifHash: string | undefined) {
    if (!env.FLUTTERWAVE_WEBHOOK_SECRET) return true;
    if (!verifHash) return false;
    return verifHash === env.FLUTTERWAVE_WEBHOOK_SECRET;
  }
}

export const flutterwaveClient = new FlutterwaveClient();

export function flutterwaveLive() {
  return useFlutterwaveLive();
}
