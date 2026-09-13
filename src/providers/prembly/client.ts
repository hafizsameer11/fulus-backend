import { env } from "../../config/env.js";
import { ProviderError } from "../../lib/errors.js";
import { providerFetch } from "../../lib/provider-http.js";

/**
 * Prembly (IdentityPass) — BVN, NIN, face, document verification.
 * Docs: https://prembly.com / IdentityPass verification APIs
 */
export class PremblyClient {
  private headers() {
    return {
      "x-api-key": env.PREMBLY_API_KEY,
      ...(env.PREMBLY_APP_ID ? { "app-id": env.PREMBLY_APP_ID } : {}),
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

  verifyBvn(number: string) {
    return this.request("/identitypass/verification/bvn", { number });
  }

  verifyBvnWithFace(number: string, image: string) {
    return this.request("/identitypass/verification/bvn_w_face", { number, image });
  }

  verifyNin(number: string) {
    return this.request("/identitypass/verification/vnin", { number });
  }

  /** NIN + face match — https://docs.prembly.com/reference/nin-with-face */
  verifyNinWithFace(number: string, image: string) {
    return this.request("/identitypass/verification/nin_w_face", { number, image });
  }

  verifyPhone(number: string) {
    return this.request("/identitypass/verification/phone_number", { number });
  }

  verifyBankAccount(number: string, bank_code: string) {
    return this.request("/identitypass/verification/bank_account", { number, bank_code });
  }
}

export const premblyClient = new PremblyClient();
