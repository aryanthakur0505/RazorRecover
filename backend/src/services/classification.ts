import { FailureCategory } from "@prisma/client";

/**
 * Deterministic failure classification layer.
 *
 * Maps a raw Razorpay `error_code` / `error_description` (and a few contextual signals)
 * to one of a fixed set of categories. This is intentionally simple pattern matching —
 * designed so it can later be swapped for an ML classifier without touching any downstream
 * consumer (scoring, decision engine, policy engine all only depend on `FailureCategory`).
 */

export interface ClassificationInput {
  errorCode?: string | null;
  errorDescription?: string | null;
  errorReason?: string | null; // razorpay's granular reason, e.g. "insufficient_funds"
  amount: number; // paise
  method?: string | null;
  eventType?: "payment.failed" | "order.paid" | "checkout.abandoned" | string;
}

export interface ClassificationResult {
  category: FailureCategory;
  confidence: number; // 0-1, how confident the deterministic rule was
  isSuspicious: boolean;
  rationale: string;
}

// Sourced from Razorpay's actual documented error_reason values —
// https://razorpay.com/docs/errors/payments/list/ — replacing an earlier guessed list that
// didn't match their real API (e.g. "suspected_fraud"/"card_blacklisted" aren't real values;
// the real risk-decline reason is "payment_risk_check_failed"). Verified 2026-08.

const SUSPICIOUS_REASONS = [
  "payment_risk_check_failed", // Razorpay/gateway/issuer risk check declined the payment
  "compliance_violation",
  "fraud", // kept as a generic net over free-text error_description, not a documented enum value
];

const INSUFFICIENT_FUNDS_REASONS = [
  "insufficient_funds",
  "transaction_daily_limit_exceeded",
  "transaction_limit_exceeded",
];

const TEMPORARY_REASONS = [
  "bank_technical_error",
  "gateway_technical_error",
  "bank_not_available",
  "issuer_technical_error",
  "payment_declined_due_to_high_traffic",
  "server_error",
  "payment_timed_out",
];

// Card/session/auth no longer usable as-is — the common remediation (a payment link, letting the
// customer retry with any method) is the same for all of these, which is why they share a bucket.
const EXPIRED_REASONS = [
  "card_expired",
  "payment_session_expired",
  "payment_collect_request_expired",
  "otp_expired",
  "otp_attempts_exceeded",
  "incorrect_otp",
  "authentication_failed",
  "debit_instrument_blocked", // card blocked by issuer *or* by the customer themselves — not
  "debit_instrument_inactive", // necessarily fraud; treated as "try a different method", not SUSPICIOUS
];

export function classifyFailure(input: ClassificationInput): ClassificationResult {
  const reason = (input.errorReason ?? "").toLowerCase();
  const code = (input.errorCode ?? "").toLowerCase();
  const description = (input.errorDescription ?? "").toLowerCase();
  const haystack = `${reason} ${code} ${description}`;

  // NOTE (verified against Razorpay's docs): "checkout.abandoned" is not a real Razorpay webhook
  // event — there's no server-to-server notification for "customer opened checkout and left
  // without paying" (an unpaid order just stays silent; nothing fails, so no payment.failed fires
  // either). This branch is only ever reached by the simulation engine today, which sets this
  // eventType synthetically. Detecting true abandonment in live traffic would need a different
  // mechanism entirely — periodically polling for orders created more than N minutes ago with no
  // matching payment — which nothing in this app currently does.
  if (input.eventType === "checkout.abandoned") {
    return {
      category: "CHECKOUT_ABANDONED",
      confidence: 0.9,
      isSuspicious: false,
      rationale: "Checkout session was created but never completed.",
    };
  }

  if (SUSPICIOUS_REASONS.some((k) => haystack.includes(k))) {
    return {
      category: "SUSPICIOUS_PAYMENT",
      confidence: 0.85,
      isSuspicious: true,
      rationale: `Failure signal matched a fraud/risk pattern (${matchedTerm(haystack, SUSPICIOUS_REASONS)}).`,
    };
  }

  if (INSUFFICIENT_FUNDS_REASONS.some((k) => haystack.includes(k))) {
    return {
      category: "INSUFFICIENT_FUNDS",
      confidence: 0.9,
      isSuspicious: false,
      rationale: `Issuer declined for insufficient balance (${matchedTerm(haystack, INSUFFICIENT_FUNDS_REASONS)}).`,
    };
  }

  if (EXPIRED_REASONS.some((k) => haystack.includes(k))) {
    return {
      category: "EXPIRED_PAYMENT",
      confidence: 0.85,
      isSuspicious: false,
      rationale: `Card/authentication expired (${matchedTerm(haystack, EXPIRED_REASONS)}).`,
    };
  }

  if (TEMPORARY_REASONS.some((k) => haystack.includes(k))) {
    return {
      category: "TEMPORARY_FAILURE",
      confidence: 0.8,
      isSuspicious: false,
      rationale: `Transient gateway/issuer error (${matchedTerm(haystack, TEMPORARY_REASONS)}).`,
    };
  }

  return {
    category: "OTHER",
    confidence: 0.4,
    isSuspicious: false,
    rationale: "No deterministic rule matched this failure signal — needs review.",
  };
}

function matchedTerm(haystack: string, terms: string[]): string {
  return terms.find((t) => haystack.includes(t)) ?? "unknown";
}
