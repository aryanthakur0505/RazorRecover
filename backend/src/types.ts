// Shared constants & lightweight types used across the deterministic engine.
// Amounts are always in paise (integer) to avoid floating point drift.

export const RECOVERY_COST = {
  // Flat, deterministic assumed cost per action (paise). Documented, not invented on the fly —
  // used consistently for every attempt so ROI numbers are reproducible.
  RETRY: 200, // ₹2 — simulated gateway/processing cost of an auto retry
  PAYMENT_LINK: 500, // ₹5 — assumed messaging/notification cost to deliver the link
  ESCALATE: 0,
  STOP: 0,
} as const;

// Approximate OpenAI cost per reasoning call (paise), used only when an attempt actually
// escalates to the AI layer. Rough flat estimate for gpt-4o-mini-class pricing at hackathon scale.
export const AI_COST_PER_CALL_PAISE = 50;

// Recovery score band that triggers AI reasoning instead of the pure deterministic path.
export const AI_ESCALATION_SCORE_BAND = { min: 35, max: 65 } as const;

export interface ScoreFactor {
  factor: string;
  impact: number; // signed contribution to the 0-100 score
  detail: string;
}

export interface ScoreResult {
  score: number;
  factors: ScoreFactor[];
}

export interface CustomerRecoveryStats {
  totalSuccessfulPayments: number;
  totalFailedPayments: number;
  previousRecoveryAttempts: number;
  previousRecoverySuccesses: number;
  recentlyContacted: boolean; // within policy communication window
  hoursSinceLastPayment: number | null;
}

export type DecisionSource = "DETERMINISTIC" | "AI";

export interface DecisionResult {
  action: "RETRY" | "PAYMENT_LINK" | "STOP" | "ESCALATE";
  source: DecisionSource;
  confidence: number; // 0-1
  riskFlags: string[];
  decisionFactors: ScoreFactor[];
  recommendedChannel?: "AUTO_DEBIT" | "PAYMENT_LINK" | "NONE";
  cause?: string;
  requiresApproval: boolean;
  approvalReason?: string;
}

export interface PolicyCheckResult {
  rule: string;
  passed: boolean;
  detail: string;
}

export interface PolicyEvaluation {
  allowed: boolean;
  checks: PolicyCheckResult[];
  requiresApproval: boolean;
  approvalReason?: string;
  stopReason?: string;
}
