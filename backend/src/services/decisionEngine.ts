import { FailureCategory, RecoveryPolicy } from "@prisma/client";
import {
  AI_ESCALATION_SCORE_BAND,
  DecisionResult,
  EMI_MIN_AMOUNT_PAISE,
  RETRY_SCORE_THRESHOLD,
  ScoreResult,
} from "../types";

/**
 * Deterministic Recovery Decision Engine.
 *
 * Given a recovery score + failure category + a few contextual signals, decides the action
 * (RETRY / PAYMENT_LINK / STOP / ESCALATE) *and* whether this case is ambiguous enough to
 * warrant a single AI reasoning call. The AI is never consulted for the routine majority of
 * cases — see `shouldEscalateToAI`.
 */

export interface DecisionInput {
  category: FailureCategory;
  isSuspicious: boolean;
  score: ScoreResult;
  amount: number;
  attemptNumber: number;
  policy: RecoveryPolicy;
  // Whether this payment already has an InstallmentPlan row (from an earlier attempt on this same
  // payment) -- the schema allows only one ever, per paymentId. A payment whose EMI offer already
  // expired/defaulted doesn't get offered EMI again on a later retry (real lenders don't keep
  // re-proposing the same restructuring that already failed); it falls through to the normal
  // score-based RETRY/PAYMENT_LINK/STOP path instead.
  hasPriorEmiOffer: boolean;
}

export function shouldEscalateToAI(input: DecisionInput): boolean {
  if (input.isSuspicious || input.category === "SUSPICIOUS_PAYMENT") return false; // never ambiguous — always STOP
  const inBand =
    input.score.score >= AI_ESCALATION_SCORE_BAND.min && input.score.score <= AI_ESCALATION_SCORE_BAND.max;
  const lowConfidenceCategory = input.category === "OTHER";
  const conflictingSignal = input.attemptNumber >= 2 && input.score.score >= 50;
  return inBand || lowConfidenceCategory || conflictingSignal;
}

export function decideDeterministic(input: DecisionInput): DecisionResult {
  const { category, isSuspicious, score, amount, attemptNumber, policy, hasPriorEmiOffer } = input;

  if (isSuspicious || category === "SUSPICIOUS_PAYMENT") {
    return {
      action: "ESCALATE",
      source: "DETERMINISTIC",
      confidence: 0.95,
      riskFlags: ["suspicious_payment"],
      decisionFactors: score.factors,
      recommendedChannel: "NONE",
      cause: "Payment flagged as suspicious — routed to manual review, never auto-retried.",
      requiresApproval: true,
      approvalReason: "SUSPICIOUS_PAYMENT",
    };
  }

  if (attemptNumber > policy.maxRetries) {
    return {
      action: "STOP",
      source: "DETERMINISTIC",
      confidence: 0.9,
      riskFlags: ["max_retries_reached"],
      decisionFactors: score.factors,
      recommendedChannel: "NONE",
      cause: `Maximum retry attempts (${policy.maxRetries}) reached without recovery.`,
      requiresApproval: false,
    };
  }

  // A payment link or an auto-retry both just ask for the SAME full amount again — the exact
  // thing that already failed for an INSUFFICIENT_FUNDS case. Above EMI_MIN_AMOUNT_PAISE, an
  // installment plan actually addresses the stated reason for the failure instead of repeating
  // it, so it takes priority over the normal score bands below (but never over the suspicious/
  // max-retries checks above — this is a different intervention, not an exemption from the same
  // attempt-count ceiling every other action respects). Sending the offer itself commits nothing
  // (no money moves, no plan exists until the customer picks a tenure), so it's no riskier than a
  // plain payment link — same amount-based approval rule as RETRY/PAYMENT_LINK below, not a
  // stricter one invented just for this action.
  if (category === "INSUFFICIENT_FUNDS" && amount >= EMI_MIN_AMOUNT_PAISE && !hasPriorEmiOffer) {
    return {
      action: "EMI_PLAN",
      source: "DETERMINISTIC",
      confidence: 0.8,
      riskFlags: [],
      decisionFactors: score.factors,
      recommendedChannel: "PAYMENT_LINK", // installments are still collected via a payment link each month
      cause: `Insufficient funds on a ${(amount / 100).toLocaleString("en-IN")} rupee payment — large enough that spreading it into monthly installments is more likely to succeed than asking for the full amount again.`,
      requiresApproval: amount > policy.maxAutoRecoveryAmount,
      approvalReason: amount > policy.maxAutoRecoveryAmount ? "AMOUNT_EXCEEDS_AUTO_LIMIT" : undefined,
    };
  }

  if (score.score >= RETRY_SCORE_THRESHOLD) {
    return {
      action: "RETRY",
      source: "DETERMINISTIC",
      confidence: 0.85,
      riskFlags: [],
      decisionFactors: score.factors,
      recommendedChannel: "AUTO_DEBIT",
      cause: `High recovery score (${score.score}) — ${category.toLowerCase()} failures usually self-resolve on retry.`,
      requiresApproval: amount > policy.maxAutoRecoveryAmount,
      approvalReason: amount > policy.maxAutoRecoveryAmount ? "AMOUNT_EXCEEDS_AUTO_LIMIT" : undefined,
    };
  }

  if (score.score >= 10) {
    return {
      action: "PAYMENT_LINK",
      source: "DETERMINISTIC",
      confidence: 0.7,
      riskFlags: score.score < 45 ? ["moderate_recovery_odds"] : [],
      decisionFactors: score.factors,
      recommendedChannel: "PAYMENT_LINK",
      cause: `Moderate recovery score (${score.score}) — a payment link gives the customer a low-friction way back in.`,
      requiresApproval: amount > policy.maxAutoRecoveryAmount,
      approvalReason: amount > policy.maxAutoRecoveryAmount ? "AMOUNT_EXCEEDS_AUTO_LIMIT" : undefined,
    };
  }

  // A low score on a KNOWN failure reason (expired card, checkout abandoned, etc.) means the
  // model has real evidence recovery is unlikely -- STOP is the honest call. A low score on
  // "OTHER" means something different: the classifier couldn't even determine why this failed,
  // so the low score reflects our own uncertainty, not necessarily the payment's true odds.
  // Auto-writing that off is giving up on "we don't know" as if it meant "we know it's bad" --
  // route it to a human instead, same as a suspicious payment gets a human look rather than an
  // automatic guess.
  if (category === "OTHER") {
    return {
      action: "ESCALATE",
      source: "DETERMINISTIC",
      confidence: 0.5,
      riskFlags: ["low_recovery_odds", "unknown_failure_reason"],
      decisionFactors: score.factors,
      recommendedChannel: "NONE",
      cause: `Low recovery score (${score.score}) on an unclassified ("Other") failure — routed to a human instead of auto-stopping, since the low score reflects not knowing why this failed rather than confirmed low odds.`,
      requiresApproval: true,
      approvalReason: "UNKNOWN_FAILURE_REASON",
    };
  }

  return {
    action: "STOP",
    source: "DETERMINISTIC",
    confidence: 0.75,
    riskFlags: ["low_recovery_odds"],
    decisionFactors: score.factors,
    recommendedChannel: "NONE",
    cause: `Low recovery score (${score.score}) — further automated attempts are unlikely to succeed. Threshold lowered from 25 to 10 -- below 10 is the only band judged too low-odds to spend an attempt on; 10-24 now gets a payment link instead of an automatic write-off.`,
    requiresApproval: false,
  };
}

/** Dunning schedule: returns minutes to wait before this attempt number is due. */
export function getRetryDelayMinutes(policy: RecoveryPolicy, attemptNumber: number): number {
  const stages = (policy.retryDelayMinutes as unknown as number[]) ?? [0, 360, 1440];
  const idx = Math.min(attemptNumber - 1, stages.length - 1);
  return stages[Math.max(idx, 0)] ?? 0;
}
