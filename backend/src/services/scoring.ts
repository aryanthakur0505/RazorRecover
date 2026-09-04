import { FailureCategory } from "@prisma/client";
import { CustomerRecoveryStats, ScoreResult } from "../types";

/**
 * Deterministic Recovery Score (0-100).
 *
 * Every contribution is recorded as a signed `ScoreFactor` so the score is always
 * explainable to a merchant (and, later, feedable back to an ML model as labeled features).
 */

const BASE_SCORE_BY_CATEGORY: Record<FailureCategory, number> = {
  TEMPORARY_FAILURE: 70,
  CHECKOUT_ABANDONED: 55,
  INSUFFICIENT_FUNDS: 50,
  EXPIRED_PAYMENT: 40,
  OTHER: 35,
  SUSPICIOUS_PAYMENT: 0,
  NONE: 0,
};

export interface ScoringInput {
  category: FailureCategory;
  amount: number; // paise
  isSuspicious: boolean;
  hoursSinceFailure: number;
  stats: CustomerRecoveryStats;
}

export function calculateRecoveryScore(input: ScoringInput): ScoreResult {
  const factors: ScoreResult["factors"] = [];

  if (input.isSuspicious) {
    factors.push({
      factor: "suspicious_payment",
      impact: -100,
      detail: "Payment flagged as suspicious — recovery score forced to 0.",
    });
    return { score: 0, factors };
  }

  let score = BASE_SCORE_BY_CATEGORY[input.category];
  factors.push({
    factor: "failure_category",
    impact: score,
    detail: `Base score for ${input.category} failures.`,
  });

  // Customer history: reward customers with a track record of paying successfully. This used to
  // be THREE separate factors (customer_success_rate, previous_recovery_attempts,
  // historical_recovery_success_rate) that all penalized the same underlying signal -- "this
  // customer has failed before" -- from slightly different angles, and stacked on top of each
  // other. A customer with just 2 prior failures and zero successes could rack up -45 across the
  // three, enough to zero out a decent base score by itself. Consolidated into two factors that
  // each carry a distinct, non-overlapping signal, with a combined cap around -30 (was -45+):
  //   - customer_track_record: their overall payment success rate -- the primary trust signal.
  //   - repeated_attempts_on_payment: a smaller, separate penalty for diminishing returns on
  //     retrying when several attempts have already been made -- capped much lower than before,
  //     since customer_track_record already captures most of "this customer often fails".
  const { totalSuccessfulPayments, totalFailedPayments } = input.stats;
  const totalPayments = totalSuccessfulPayments + totalFailedPayments;
  if (totalPayments > 0) {
    const successRate = totalSuccessfulPayments / totalPayments;
    const impact = Math.max(-18, Math.min(18, Math.round((successRate - 0.5) * 36))); // -18..+18
    score += impact;
    factors.push({
      factor: "customer_track_record",
      impact,
      detail: `Customer has succeeded on ${(successRate * 100).toFixed(0)}% of ${totalPayments} past payments.`,
    });
  }

  if (input.stats.previousRecoveryAttempts > 0) {
    const impact = -Math.min(4 * input.stats.previousRecoveryAttempts, 12); // 0..-12
    score += impact;
    factors.push({
      factor: "repeated_attempts_on_payment",
      impact,
      detail: `${input.stats.previousRecoveryAttempts} prior recovery attempt(s) already made — diminishing returns on trying again.`,
    });
  }

  // Time decay: recovery odds drop the longer a payment sits unresolved, but a very fresh
  // failure (network blip) is also slightly discounted — the sweet spot is a few hours in,
  // once the customer has had a chance to notice/retry on their own.
  let timeImpact = 0;
  if (input.hoursSinceFailure < 0.25) {
    timeImpact = -5;
  } else if (input.hoursSinceFailure <= 48) {
    timeImpact = 10;
  } else if (input.hoursSinceFailure <= 168) {
    timeImpact = -5;
  } else {
    timeImpact = -20;
  }
  score += timeImpact;
  factors.push({
    factor: "time_since_failure",
    impact: timeImpact,
    detail: `${input.hoursSinceFailure.toFixed(1)}h since failure.`,
  });

  // Large amounts are inherently riskier to recover automatically — a mild penalty nudges
  // big-ticket failures toward human review rather than blind auto-retry (policy engine
  // enforces the hard cutoff; this is just a soft signal).
  if (input.amount > 1000000) {
    score -= 10;
    factors.push({
      factor: "high_amount",
      impact: -10,
      detail: `Amount ₹${(input.amount / 100).toFixed(2)} is high-value — treated more cautiously.`,
    });
  }

  // Recently contacted customers are less likely to respond to another nudge immediately.
  if (input.stats.recentlyContacted) {
    score -= 8;
    factors.push({
      factor: "recently_contacted",
      impact: -8,
      detail: "Customer was already contacted recently — diminishing returns on another message.",
    });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  return { score, factors };
}
