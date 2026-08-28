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

const SUSPICIOUS_REASONS = [
  "fraud",
  "risk",
  "blocked",
  "blacklist",
  "suspected_fraud",
  "card_blacklisted",
];

const INSUFFICIENT_FUNDS_REASONS = ["insufficient_funds", "balance", "limit_exceeded"];

const TEMPORARY_REASONS = [
  "gateway_error",
  "network",
  "timeout",
  "issuer_unavailable",
  "bank_error",
  "server_error",
  "processing_error",
];

const EXPIRED_REASONS = ["card_expired", "expired", "otp_timeout", "authentication_failed"];

export function classifyFailure(input: ClassificationInput): ClassificationResult {
  const reason = (input.errorReason ?? "").toLowerCase();
  const code = (input.errorCode ?? "").toLowerCase();
  const description = (input.errorDescription ?? "").toLowerCase();
  const haystack = `${reason} ${code} ${description}`;

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
