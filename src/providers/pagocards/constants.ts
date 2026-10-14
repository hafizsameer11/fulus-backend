/**
 * Pagocards 4XX BIN card products (v1 Cards API).
 * @see https://pagocards.com/documentation#v1-cards-create
 */
export const PAGO_VISA_BIN_PRODUCT = "us_404_visa_bin" as const;

/** Display / storage hint for issued cards (404xxxx Visa). */
export const PAGO_VISA_BIN_HINT = "404";

/**
 * Fixed AVS / billing address for all issued virtual cards.
 * Not user-editable — merchants verify against this issuer address.
 */
export const PAGO_CARD_BILLING_ADDRESS = {
  line1: "3401 N. Miami, Ave. Ste 230",
  line2: "",
  city: "Miami",
  state: "Florida",
  postal_code: "33127",
  country: "United States",
} as const;
