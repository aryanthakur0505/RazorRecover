import crypto from "crypto";
import Razorpay from "razorpay";
import { env } from "../env";

export const razorpay = new Razorpay({
  key_id: env.RAZORPAY_KEY_ID,
  key_secret: env.RAZORPAY_KEY_SECRET,
});

/**
 * Verifies a Razorpay webhook signature using HMAC-SHA256 over the raw request body,
 * per Razorpay's documented verification scheme. Uses a timing-safe comparison.
 * https://razorpay.com/docs/webhooks/validate-test/
 */
export function verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = crypto
    .createHmac("sha256", env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
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
export async function createPaymentLink(params: CreatePaymentLinkParams) {
  return razorpay.paymentLink.create({
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
export async function createRetryOrder(params: CreateRetryOrderParams) {
  return razorpay.orders.create({
    amount: params.amount,
    currency: params.currency,
    receipt: params.receipt,
  });
}

export async function fetchPayment(paymentId: string) {
  return razorpay.payments.fetch(paymentId);
}

export async function fetchOrder(orderId: string) {
  return razorpay.orders.fetch(orderId);
}
