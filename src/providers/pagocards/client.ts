import { randomBytes } from "node:crypto";
import { env } from "../../config/env.js";
import { ProviderError } from "../../lib/errors.js";
import { providerFetch } from "../../lib/provider-http.js";
import { PAGO_VISA_BIN_PRODUCT } from "./constants.js";

/**
 * Pagocards v1 Cards API — 493 Visa BIN (`us_493_visa_bin`).
 * Docs: https://pagocards.com/documentation#v1-cards-create
 */
export class PagocardsClient {
  private headers(extra?: Record<string, string>) {
    return {
      publickey: env.PAGOCARDS_PUBLIC_KEY,
      secretkey: env.PAGOCARDS_SECRET_KEY,
      ...extra,
    };
  }

  private idempotencyKey(label: string) {
    return `${label}_${Date.now()}_${randomBytes(6).toString("hex")}`;
  }

  private async request<T>(
    path: string,
    options: {
      method?: "GET" | "POST" | "PUT";
      body?: Record<string, unknown>;
      idempotent?: boolean;
      idempotencyLabel?: string;
    } = {},
  ) {
    if (!env.PAGOCARDS_PUBLIC_KEY || !env.PAGOCARDS_SECRET_KEY) {
      throw new ProviderError("pagocards", "API keys are not configured");
    }

    const method = options.method ?? (options.body ? "POST" : "GET");
    const idem =
      options.idempotent && method === "POST"
        ? { "Idempotency-Key": this.idempotencyKey(options.idempotencyLabel ?? "pago") }
        : undefined;

    const { status, data } = await providerFetch<T>(env.PAGOCARDS_BASE_URL, {
      method,
      path,
      body: options.body,
      headers: this.headers(idem),
    });

    if (status >= 400) {
      throw new ProviderError("pagocards", `Request failed with status ${status}`, data);
    }

    return data;
  }

  /** POST /api/v1/cards — Visa 493 BIN virtual card. */
  createVisaCard(input: {
    first_name: string;
    last_name: string;
    email: string;
    initial_load?: number;
  }) {
    return this.request("/api/v1/cards", {
      body: {
        product_code: PAGO_VISA_BIN_PRODUCT,
        first_name: input.first_name,
        last_name: input.last_name,
        email: input.email,
        ...(input.initial_load != null && input.initial_load > 0 ? { initial_load: input.initial_load } : {}),
      },
      idempotent: true,
      idempotencyLabel: "create_card",
    });
  }

  getCard(cardId: string) {
    return this.request(`/api/v1/cards/${encodeURIComponent(cardId)}`, { method: "GET" });
  }

  listVisaCards(input: { email: string }) {
    return this.request("/api/v1/cards/getallcards", {
      body: {
        email: input.email,
        product_code: PAGO_VISA_BIN_PRODUCT,
      },
    });
  }

  fundVisaCard(input: { card_id: string; amount: number }) {
    return this.request(`/api/v1/cards/${encodeURIComponent(input.card_id)}/fund`, {
      body: { amount: input.amount },
      idempotent: true,
      idempotencyLabel: "fund_card",
    });
  }

  /** POST /api/v1/cards/{id}/withdraw — USD off card → merchant 400BIN wallet (no Pagocards fee). */
  withdrawVisaCard(input: { card_id: string; amount: number }) {
    return this.request(`/api/v1/cards/${encodeURIComponent(input.card_id)}/withdraw`, {
      body: { amount: input.amount },
      idempotent: true,
      idempotencyLabel: "withdraw_card",
    });
  }

  blockVisaCard(input: { card_id: string }) {
    return this.request(`/api/v1/cards/${encodeURIComponent(input.card_id)}/block`, {
      method: "POST",
      idempotent: true,
      idempotencyLabel: "block_card",
    });
  }

  unblockVisaCard(input: { card_id: string }) {
    return this.request(`/api/v1/cards/${encodeURIComponent(input.card_id)}/unblock`, {
      method: "POST",
      idempotent: true,
      idempotencyLabel: "unblock_card",
    });
  }

  terminateCard(input: { card_id: string }) {
    return this.request(`/api/v1/cards/${encodeURIComponent(input.card_id)}/terminate`, {
      method: "POST",
      idempotent: true,
      idempotencyLabel: "terminate_card",
    });
  }

  /** Legacy Visacard spend controls — still documented under Visacard API. */
  setSpendControls(input: Record<string, unknown>) {
    return this.request("/api/visacard/spendcontrols", {
      method: "PUT",
      body: input as Record<string, unknown>,
    });
  }
}

export const pagocardsClient = new PagocardsClient();
