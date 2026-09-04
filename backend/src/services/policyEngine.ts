import { FailureCategory, PaymentStatus, RecoveryAction, RecoveryPolicy } from "@prisma/client";
import { PolicyCheckResult, PolicyEvaluation } from "../types";

/**
 * Deterministic Policy & Guardrail Engine.
 *
 * This is the ONLY place that is allowed to say "yes, execute this action". The AI agent and
 * the deterministic decision engine may only *recommend* — every recommendation, AI or not,
 * is re-checked here before anything reaches Razorpay. Pure functions, no I/O, fully unit
 * testable in isolation.
 */

export interface PolicyEvalInput {
  action: RecoveryAction;
  attemptNumber: number;
  amount: number; // paise
  paymentStatus: PaymentStatus;
  failureCategory: FailureCategory;
  isSuspicious: boolean;
  doNotContact: boolean; // merchant-set exclude flag on the customer — never auto-contacted
  communicationsInPeriod: number; // count of PAYMENT_LINK/contact actions already sent in window
  minutesSinceLastAttempt: number | null;
  currentHourLocal: number; // 0-23
  policy: RecoveryPolicy;
  /** Set only by an explicit merchant "Retry Anyway" override on a previously-STOPPED attempt —
   *  a human judgment call let through past the *timing/volume* guardrails (retry limit, comms
   *  limit, quiet hours, retry spacing), which a merchant might reasonably know better than the
   *  policy defaults for one specific case. Never bypasses payment_state, suspicious_payment, or
   *  do_not_contact — those aren't about timing or volume, they're either "there's nothing to
   *  recover" or a safety boundary the merchant set deliberately elsewhere, and this isn't the
   *  place to undo either of those. */
  bypassSoftGuardrails?: boolean;
}

export function evaluatePolicy(input: PolicyEvalInput): PolicyEvaluation {
  const checks: PolicyCheckResult[] = [];
  let allowed = true;
  let requiresApproval = false;
  let approvalReason: string | undefined;
  let stopReason: string | undefined;

  // 1. Payment state rule — never act on a payment that already succeeded / was refunded.
  const paymentStateOk = input.paymentStatus !== "CAPTURED" && input.paymentStatus !== "REFUNDED";
  checks.push({
    rule: "payment_state",
    passed: paymentStateOk,
    detail: paymentStateOk
      ? "Payment is not yet successfully captured."
      : `Payment status is already ${input.paymentStatus} — no recovery action needed.`,
  });
  if (!paymentStateOk) {
    allowed = false;
    stopReason = "PAYMENT_ALREADY_RESOLVED";
  }

  // 2. Suspicious payment rule — never auto-retry or send a payment link for suspicious payments.
  //    STOP/ESCALATE are always allowed regardless of suspicion (that's the safe path for them).
  const flaggedSuspicious = input.isSuspicious || input.failureCategory === "SUSPICIOUS_PAYMENT";
  const suspiciousOk =
    input.action === "STOP" || input.action === "ESCALATE" ? true : !flaggedSuspicious;
  checks.push({
    rule: "suspicious_payment",
    passed: suspiciousOk,
    detail: suspiciousOk
      ? "Payment is not flagged suspicious."
      : "Payment is suspicious — automatic RETRY/PAYMENT_LINK is forbidden by policy.",
  });
  if (!suspiciousOk) {
    allowed = false;
    stopReason = "SUSPICIOUS_PAYMENT";
  }

  // 2b. Do-not-contact rule — merchant has explicitly excluded this customer (fraud, already
  //     refunded, or asked not to be contacted again). Same shape as the suspicious-payment rule:
  //     STOP/ESCALATE stay allowed (ESCALATE is a human review, not an automatic message), only
  //     automatic RETRY/PAYMENT_LINK are forbidden.
  const doNotContactOk =
    input.action === "STOP" || input.action === "ESCALATE" ? true : !input.doNotContact;
  checks.push({
    rule: "do_not_contact",
    passed: doNotContactOk,
    detail: doNotContactOk
      ? "Customer is not on the do-not-contact list."
      : "Customer is on the do-not-contact list — automatic RETRY/PAYMENT_LINK is forbidden.",
  });
  if (!doNotContactOk) {
    allowed = false;
    stopReason = "DO_NOT_CONTACT";
  }

  // 3. Retry limit
  if (input.action === "RETRY") {
    const withinRetryLimit =
      input.bypassSoftGuardrails || input.attemptNumber <= input.policy.maxRetries;
    checks.push({
      rule: "retry_limit",
      passed: withinRetryLimit,
      detail:
        input.bypassSoftGuardrails && input.attemptNumber > input.policy.maxRetries
          ? `Attempt ${input.attemptNumber} exceeds max retries (${input.policy.maxRetries}), but a merchant explicitly overrode this.`
          : withinRetryLimit
            ? `Attempt ${input.attemptNumber} of ${input.policy.maxRetries} allowed retries.`
            : `Attempt ${input.attemptNumber} exceeds max retries (${input.policy.maxRetries}).`,
    });
    if (!withinRetryLimit) {
      allowed = false;
      stopReason = "MAX_RETRIES_REACHED";
    }
  }

  // 4. Amount limit — auto-execute only under the configured ceiling; above it, require approval.
  if (input.action === "RETRY" || input.action === "PAYMENT_LINK") {
    const withinAmountLimit = input.amount <= input.policy.maxAutoRecoveryAmount;
    checks.push({
      rule: "amount_limit",
      passed: withinAmountLimit,
      detail: withinAmountLimit
        ? `Amount ₹${(input.amount / 100).toFixed(2)} is within the ₹${(input.policy.maxAutoRecoveryAmount / 100).toFixed(2)} auto-recovery limit.`
        : `Amount ₹${(input.amount / 100).toFixed(2)} exceeds the ₹${(input.policy.maxAutoRecoveryAmount / 100).toFixed(2)} auto-recovery limit — human approval required.`,
    });
    if (!withinAmountLimit) {
      requiresApproval = true;
      approvalReason = "AMOUNT_EXCEEDS_AUTO_LIMIT";
    }
  }

  // 5. Communication limit
  if (input.action === "PAYMENT_LINK") {
    const withinCommsLimit =
      input.bypassSoftGuardrails || input.communicationsInPeriod < input.policy.maxCommunicationsPerPeriod;
    checks.push({
      rule: "communication_limit",
      passed: withinCommsLimit,
      detail:
        input.bypassSoftGuardrails && input.communicationsInPeriod >= input.policy.maxCommunicationsPerPeriod
          ? `Communication limit reached (${input.communicationsInPeriod}/${input.policy.maxCommunicationsPerPeriod} in ${input.policy.communicationPeriodHours}h), but a merchant explicitly overrode this.`
          : withinCommsLimit
            ? `${input.communicationsInPeriod}/${input.policy.maxCommunicationsPerPeriod} communications sent in the last ${input.policy.communicationPeriodHours}h.`
            : `Communication limit reached (${input.communicationsInPeriod}/${input.policy.maxCommunicationsPerPeriod} in ${input.policy.communicationPeriodHours}h).`,
    });
    if (!withinCommsLimit) {
      allowed = false;
      stopReason = "COMMUNICATION_LIMIT_REACHED";
    }
  }

  // 6. Quiet hours — block auto RETRY/PAYMENT_LINK during configured quiet hours.
  if (input.action === "RETRY" || input.action === "PAYMENT_LINK") {
    const inQuietHours = isWithinQuietHours(
      input.currentHourLocal,
      input.policy.quietHoursStart,
      input.policy.quietHoursEnd,
    );
    const quietHoursOk = input.bypassSoftGuardrails || !inQuietHours;
    checks.push({
      rule: "quiet_hours",
      passed: quietHoursOk,
      detail:
        input.bypassSoftGuardrails && inQuietHours
          ? `Current hour ${input.currentHourLocal}:00 falls within quiet hours (${input.policy.quietHoursStart}:00-${input.policy.quietHoursEnd}:00), but a merchant explicitly overrode this.`
          : inQuietHours
            ? `Current hour ${input.currentHourLocal}:00 falls within quiet hours (${input.policy.quietHoursStart}:00-${input.policy.quietHoursEnd}:00) — action deferred.`
            : `Current hour ${input.currentHourLocal}:00 is outside quiet hours.`,
    });
    if (!quietHoursOk) {
      allowed = false;
      stopReason = "QUIET_HOURS";
    }
  }

  // 7. Minimum retry interval — don't hammer the customer/issuer back-to-back.
  if (input.action === "RETRY" && input.minutesSinceLastAttempt !== null) {
    const spacingOk =
      input.bypassSoftGuardrails || input.minutesSinceLastAttempt >= input.policy.minRetryIntervalMinutes;
    checks.push({
      rule: "min_retry_interval",
      passed: spacingOk,
      detail:
        input.bypassSoftGuardrails && input.minutesSinceLastAttempt < input.policy.minRetryIntervalMinutes
          ? `Only ${input.minutesSinceLastAttempt}min since last attempt (min ${input.policy.minRetryIntervalMinutes}min), but a merchant explicitly overrode this.`
          : spacingOk
            ? `${input.minutesSinceLastAttempt}min since last attempt (min ${input.policy.minRetryIntervalMinutes}min).`
            : `Only ${input.minutesSinceLastAttempt}min since last attempt — must wait ${input.policy.minRetryIntervalMinutes}min.`,
    });
    if (!spacingOk) {
      allowed = false;
      stopReason = "RETRY_TOO_SOON";
    }
  }

  return { allowed, checks, requiresApproval, approvalReason, stopReason };
}

function isWithinQuietHours(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) {
    return hour >= start && hour < end;
  }
  // wraps past midnight, e.g. 22 -> 8
  return hour >= start || hour < end;
}
