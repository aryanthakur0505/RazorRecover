import crypto from "crypto";
import Razorpay from "razorpay";
import { decryptSecret } from "./crypto";

/**
 * A merchant's own Razorpay Test Mode credentials, as stored on their Merchant row. Each real
 * merchant connects their own account (see the Merchant model doc in schema.prisma) — a
 * payment-recovery tool only has anything to recover on the account whose checkout actually
 * failed, so this can no longer be one app-wide credential from env once there's more than one
 * real merchant.
 */
export interface MerchantRazorpayCredentials {
  razorpayKeyId: string | null;
  razorpayKeySecretEncrypted: string | null;
  razorpayWebhookSecretEncrypted: string | null;
}

export class RazorpayNotConnectedError extends Error {
  constructor() {
    super("This merchant hasn't connected a Razorpay account yet.");
  }
}

/** Builds a Razorpay client from a merchant's own stored (encrypted) credentials. Throws
 *  RazorpayNotConnectedError rather than silently falling back to anything shared — there is no
 *  app-wide Razorpay account for this to fall back to. */
export function getRazorpayClient(merchant: MerchantRazorpayCredentials): Razorpay {
  if (!merchant.razorpayKeyId || !merchant.razorpayKeySecretEncrypted) {
    throw new RazorpayNotConnectedError();
  }
  return new Razorpay({
    key_id: merchant.razorpayKeyId,
    key_secret: decryptSecret(merchant.razorpayKeySecretEncrypted),
  });
}

/**
 * Verifies a Razorpay webhook signature using HMAC-SHA256 over the raw request body, against
 * *this* merchant's own webhook secret — per Razorpay's documented verification scheme, with a
 * timing-safe comparison. https://razorpay.com/docs/webhooks/validate-test/
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | undefined,
  webhookSecretEncrypted: string | null,
): boolean {
  if (!signature || !webhookSecretEncrypted) return false;
  const secret = decryptSecret(webhookSecretEncrypted);
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signature, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

export interface CreatePaymentLinkParams {
  amount: number; // paise
  currency: string;
  customerName: string;
  customerEmail: string;
  description: string;
  referenceId: string;
}

/** Creates a real Razorpay Test Mode payment link. Only ever called from executionService,
 *  never directly by the AI layer. */
export async function createPaymentLink(client: Razorpay, params: CreatePaymentLinkParams) {
  return client.paymentLink.create({
    amount: params.amount,
    currency: params.currency,
    accept_partial: false,
    description: params.description,
    customer: {
      name: params.customerName,
      email: params.customerEmail,
    },
    notify: { sms: false, email: true },
    reference_id: params.referenceId,
  });
}

export interface CreateRetryOrderParams {
  amount: number;
  currency: string;
  receipt: string;
}

/** Creates a fresh Razorpay Order to back a retry attempt (Test Mode cannot silently
 *  re-charge a previously failed card — this gives the customer a valid order to complete). */
export async function createRetryOrder(client: Razorpay, params: CreateRetryOrderParams) {
  return client.orders.create({
    amount: params.amount,
    currency: params.currency,
    receipt: params.receipt,
  });
}

export async function fetchPayment(client: Razorpay, paymentId: string) {
  return client.payments.fetch(paymentId);
}

export async function fetchOrder(client: Razorpay, orderId: string) {
  return client.orders.fetch(orderId);
}
