import { env } from "../../config/env.js";
import { ProviderError } from "../../lib/errors.js";
import { providerFetch } from "../../lib/provider-http.js";

/**
 * Prembly IdentityPass — latest LIVE API (docs v2).
 * Auth: Secret Key only via `x-api-key` (no app-id).
 * Base paths: `/verification/...` (not `/identitypass/verification/...`).
 * @see https://docs.prembly.com/docs/authentication
 * @see https://docs.prembly.com/reference/nin-with-face
 */
export class PremblyClient {
  private headers() {
    return {
      "x-api-key": env.PREMBLY_API_KEY,
    };
  }

  private async request<T>(path: string, body: Record<string, unknown>) {
    if (!env.PREMBLY_API_KEY) {
      throw new ProviderError("prembly", "API key is not configured");
    }

    const { status, data } = await providerFetch<T>(env.PREMBLY_BASE_URL, {
      method: "POST",
      path,
      body,
      headers: this.headers(),
    });

    if (status >= 400) {
      throw new ProviderError("prembly", `Request failed with status ${status}`, data);
    }

    return data;
  }

  /** BVN Basic — https://docs.prembly.com/docs/bvn-basic-copy */
  verifyBvn(number: string) {
    return this.request("/verification/bvn_validation", { number });
  }

  /** BVN + Face — https://docs.prembly.com/docs/bvn-face-validation-copy */
  verifyBvnWithFace(number: string, image: string) {
    return this.request("/verification/bvn_w_face", { number, image });
  }

  /** NIN Advance — https://docs.prembly.com/docs/nin-and-virtual-nin-copy */
  verifyNin(number: string) {
    return this.request("/verification/vnin", { number_nin: number, number });
  }

  /**
   * NIN + Face — https://docs.prembly.com/reference/nin-with-face
   * OpenAPI body: number_nin, image, date_of_birth
   * Guide also accepts `number`; we send both for compatibility.
   */
  verifyNinWithFace(number: string, image: string, dateOfBirth?: string) {
    return this.request("/verification/nin_w_face", {
      number,
      number_nin: number,
      image,
      ...(dateOfBirth ? { date_of_birth: dateOfBirth } : {}),
    });
  }

  /** Phone basic — https://docs.prembly.com/docs/basic-phone-number-copy */
  verifyPhone(number: string) {
    return this.request("/verification/phone_number", { number });
  }

  /** Bank account basic — https://docs.prembly.com/docs/bank-accounts-basic-copy */
  verifyBankAccount(number: string, bank_code: string) {
    return this.request("/verification/bank_account/basic", { number, bank_code });
  }
}

export const premblyClient = new PremblyClient();
