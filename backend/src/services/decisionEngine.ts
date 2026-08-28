import { FailureCategory, RecoveryPolicy } from "@prisma/client";
import { AI_ESCALATION_SCORE_BAND, DecisionResult, ScoreResult } from "../types";

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
  const { category, isSuspicious, score, amount, attemptNumber, policy } = input;

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

  if (score.score >= 70) {
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

  if (score.score >= 25) {
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

  return {
    action: "STOP",
    source: "DETERMINISTIC",
    confidence: 0.75,
    riskFlags: ["low_recovery_odds"],
    decisionFactors: score.factors,
    recommendedChannel: "NONE",
    cause: `Low recovery score (${score.score}) — further automated attempts are unlikely to succeed.`,
    requiresApproval: false,
  };
}

/** Dunning schedule: returns minutes to wait before this attempt number is due. */
export function getRetryDelayMinutes(policy: RecoveryPolicy, attemptNumber: number): number {
  const stages = (policy.retryDelayMinutes as unknown as number[]) ?? [0, 360, 1440];
  const idx = Math.min(attemptNumber - 1, stages.length - 1);
  return stages[Math.max(idx, 0)] ?? 0;
}
