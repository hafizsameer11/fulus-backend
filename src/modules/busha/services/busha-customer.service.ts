import { prisma } from "../../../lib/prisma.js";
import { createInboxMessage } from "../../../lib/inbox.js";
import { bushaClient } from "../../../providers/busha/client.js";
import { useBushaLive } from "../../../lib/simulate.js";
import { simRef } from "../../../lib/simulate.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function unwrapData(payload: unknown): Record<string, unknown> {
  const root = asRecord(payload);
  if (root.data && typeof root.data === "object") return asRecord(root.data);
  return root;
}

/** YYYY-MM-DD → DD-MM-YYYY for Busha birth_date */
export function toBushaBirthDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  // already DD-MM-YYYY or Prembly style
  const dmy = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(iso.trim());
  if (dmy) return `${dmy[1]}-${dmy[2]}-${dmy[3]}`;
  return iso.trim();
}

export function toE164Ng(phone?: string | null): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (!digits) return "+234 8010000000";
  if (digits.startsWith("234") && digits.length >= 13) {
    return `+234 ${digits.slice(3)}`;
  }
  if (digits.startsWith("0") && digits.length >= 11) {
    return `+234 ${digits.slice(1)}`;
  }
  return `+234 ${digits}`;
}

function stripDataUrl(image: string): string {
  const i = image.indexOf("base64,");
  return i >= 0 ? image.slice(i + 7) : image;
}

function namesFromPrembly(result: unknown, fallbackFirst?: string | null, fallbackLast?: string | null) {
  const root = asRecord(result);
  const ninData = asRecord(root.nin_data ?? root.data);
  const first =
    String(ninData.firstname ?? ninData.first_name ?? fallbackFirst ?? "Customer").trim() || "Customer";
  const last =
    String(ninData.surname ?? ninData.last_name ?? fallbackLast ?? "User").trim() || "User";
  return { firstName: first, lastName: last };
}

export type BushaNinKycInput = {
  userId: string;
  nin: string;
  dateOfBirth: string;
  selfieImage: string;
  premblyResult?: unknown;
};

/**
 * After Prembly NIN+selfie pass: create Busha individual customer with national-id + selfie, then verify.
 */
export class BushaCustomerService {
  async createFromNinKyc(input: BushaNinKycInput) {
    const user = await prisma.user.findUnique({ where: { id: input.userId } });
    if (!user) return null;

    if (!useBushaLive()) {
      const fakeId = simRef("CUS");
      await prisma.user.update({
        where: { id: user.id },
        data: {
          bushaCustomerId: user.bushaCustomerId ?? fakeId,
          bushaCustomerStatus: "active",
          dateOfBirth: input.dateOfBirth,
          nin: input.nin,
        },
      });
      await createInboxMessage({
        userId: user.id,
        category: "kyc",
        title: "Crypto KYC ready",
        body: "Your NIN selfie passed. Busha customer was created in demo mode.",
      });
      return { id: fakeId, status: "active", simulated: true };
    }

    const { firstName, lastName } = namesFromPrembly(input.premblyResult, user.firstName, user.lastName);
    const selfie = stripDataUrl(input.selfieImage);
    const birthDate = toBushaBirthDate(input.dateOfBirth);

    const body: Record<string, unknown> = {
      email: user.email,
      has_accepted_terms: true,
      type: "individual",
      country_id: "NG",
      phone: toE164Ng(user.phone),
      birth_date: birthDate,
      first_name: firstName,
      last_name: lastName,
      address: {
        city: "Lagos",
        state: "Lagos",
        country_id: "NG",
        address_line_1: "Nigeria",
        postal_code: "100001",
      },
      identifying_information: [
        {
          type: "national-id",
          number: input.nin,
          country: "NG",
        },
        {
          type: "selfie",
          image_front: selfie,
          number: "",
          country: "NG",
        },
      ],
    };

    let customerId: string | null = user.bushaCustomerId;
    let createPayload: unknown;

    if (customerId) {
      createPayload = await bushaClient.updateCustomer(customerId, body);
    } else {
      createPayload = await bushaClient.createCustomer(body);
      const data = unwrapData(createPayload);
      customerId = typeof data.id === "string" ? data.id : null;
    }

    if (!customerId) {
      throw new Error("Busha did not return a customer id");
    }

    try {
      await bushaClient.verifyCustomer(customerId);
    } catch (err) {
      console.error("[busha] verifyCustomer", err);
    }

    let status = "in_review";
    try {
      const fetched = unwrapData(await bushaClient.getCustomer(customerId));
      if (typeof fetched.status === "string") status = fetched.status;
    } catch {
      // keep in_review
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        bushaCustomerId: customerId,
        bushaCustomerStatus: status,
        dateOfBirth: input.dateOfBirth,
        nin: input.nin,
        firstName: user.firstName ?? firstName,
        lastName: user.lastName ?? lastName,
      },
    });

    await createInboxMessage({
      userId: user.id,
      category: "kyc",
      title: status === "active" ? "Busha KYC approved" : "Busha KYC submitted",
      body:
        status === "active"
          ? "Your Busha customer profile is active. Crypto trading is unlocked."
          : "Your NIN and selfie were sent to Busha for review. We'll notify you when verification finishes.",
    });

    return { id: customerId, status, payload: createPayload };
  }

  async syncStatusFromWebhook(customerId: string, status: string, rejectionReason?: string) {
    const user = await prisma.user.findFirst({ where: { bushaCustomerId: customerId } });
    if (!user) return null;

    await prisma.user.update({
      where: { id: user.id },
      data: { bushaCustomerStatus: status },
    });

    if (status === "active") {
      await createInboxMessage({
        userId: user.id,
        category: "kyc",
        title: "Busha KYC approved",
        body: "Your Busha identity check passed. You can use crypto features.",
      });
    } else if (status === "rejected") {
      await createInboxMessage({
        userId: user.id,
        category: "kyc",
        title: "Busha KYC rejected",
        body: rejectionReason?.trim()
          ? `${rejectionReason.trim()} Open Verification to update your details.`
          : "Busha could not verify your documents. Open Verification to resubmit NIN and selfie.",
      });
    } else if (status === "in_review") {
      await createInboxMessage({
        userId: user.id,
        category: "kyc",
        title: "Busha KYC under review",
        body: "Your Busha customer verification is still under review.",
      });
    }

    return user;
  }
}

export const bushaCustomerService = new BushaCustomerService();
