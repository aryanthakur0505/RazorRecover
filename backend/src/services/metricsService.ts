import { prisma } from "../db";
import { RECOVERY_COST, ESCALATION_MANUAL_RESOLUTION_RATE } from "../types";
import { RecoveryAction, Prisma } from "@prisma/client";

/**
 * All business metrics are computed live from stored rows — nothing here is a hand-set or
 * hard-coded number. Same query set powers both the live dashboard and post-simulation summary.
 */
export async function getDashboardMetrics(merchantId: string) {
  const [failedPayments, attempts] = await Promise.all([
    prisma.payment.findMany({ where: { merchantId, status: "FAILED" }, select: { amount: true } }),
    prisma.recoveryAttempt.findMany({ where: { merchantId } }),
  ]);

  const revenueAtRisk = failedPayments.reduce((sum, p) => sum + p.amount, 0);
  const revenueRecovered = attempts.reduce((sum, a) => sum + (a.revenueRecovered ?? 0), 0);
  const recoveryCost = attempts.reduce((sum, a) => sum + (a.recoveryCost ?? 0), 0);
  const netRecoveredRevenue = revenueRecovered - recoveryCost;

  const resolvedAttempts = attempts.filter((a) => a.status === "SUCCEEDED" || a.status === "FAILED");
  const succeeded = attempts.filter((a) => a.status === "SUCCEEDED");
  const recoveryRate = resolvedAttempts.length > 0 ? succeeded.length / resolvedAttempts.length : 0;
  const costPerRecovery = succeeded.length > 0 ? recoveryCost / succeeded.length : 0;
  const netROI = recoveryCost > 0 ? netRecoveredRevenue / recoveryCost : 0;

  const pendingApprovals = attempts.filter((a) => a.status === "AWAITING_APPROVAL").length;

  return {
    revenueAtRisk,
    revenueRecovered,
    netRecoveredRevenue,
    recoveryCost,
    recoveryRate,
    costPerRecovery,
    netROI,
    totalAttempts: attempts.length,
    successfulRecoveries: succeeded.length,
    failedRecoveries: attempts.filter((a) => a.status === "FAILED").length,
    pendingApprovals,
  };
}

/**
 * Every other query here is recovery-centric (failed payments, attempts) by design — a payment
 * that succeeded on the first try never creates a RecoveryAttempt, so it's invisible to them.
 * This one covers the full payment book so the dashboard can show a real baseline: how many
 * payments came through total, and how many succeeded (either outright, or after recovery).
 */
export async function getPaymentsOverview(merchantId: string) {
  const payments = await prisma.payment.findMany({
    where: { merchantId },
    select: { status: true, amount: true },
  });

  const successful = payments.filter((p) => p.status === "CAPTURED");
  const totalVolume = payments.reduce((sum, p) => sum + p.amount, 0);
  const successfulVolume = successful.reduce((sum, p) => sum + p.amount, 0);

  return {
    totalPayments: payments.length,
    successfulPayments: successful.length,
    totalVolume,
    successfulVolume,
    baselineSuccessRate: payments.length > 0 ? successful.length / payments.length : 0,
  };
}

export async function getRevenueOverTime(merchantId: string, days = 14) {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const attempts = await prisma.recoveryAttempt.findMany({
    where: { merchantId, createdAt: { gte: since }, status: { in: ["SUCCEEDED", "FAILED"] } },
    select: { createdAt: true, revenueRecovered: true, recoveryCost: true, status: true },
  });

  const byDay = new Map<string, { recovered: number; cost: number }>();
  for (const a of attempts) {
    const key = a.createdAt.toISOString().slice(0, 10);
    const entry = byDay.get(key) ?? { recovered: 0, cost: 0 };
    entry.recovered += a.revenueRecovered ?? 0;
    entry.cost += a.recoveryCost ?? 0;
    byDay.set(key, entry);
  }

  return Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, revenueRecovered: v.recovered, recoveryCost: v.cost }));
}

export async function getRecoveryByFailureType(merchantId: string) {
  const payments = await prisma.payment.findMany({
    where: { merchantId, status: "FAILED", failureCategory: { not: "NONE" } },
    select: { failureCategory: true },
  });
  const counts = new Map<string, number>();
  for (const p of payments) counts.set(p.failureCategory, (counts.get(p.failureCategory) ?? 0) + 1);
  return Array.from(counts.entries()).map(([category, count]) => ({ category, count }));
}

export async function getRecoveryByAction(merchantId: string) {
  const attempts = await prisma.recoveryAttempt.findMany({ where: { merchantId }, select: { action: true } });
  const counts = new Map<string, number>();
  for (const a of attempts) counts.set(a.action, (counts.get(a.action) ?? 0) + 1);
  return Array.from(counts.entries()).map(([action, count]) => ({ action, count }));
}

export async function getAttemptOutcomeBreakdown(merchantId: string) {
  const attempts = await prisma.recoveryAttempt.findMany({
    where: { merchantId, status: { in: ["SUCCEEDED", "FAILED"] } },
    select: { status: true },
  });
  const succeeded = attempts.filter((a) => a.status === "SUCCEEDED").length;
  const failed = attempts.filter((a) => a.status === "FAILED").length;
  return { succeeded, failed };
}

export interface OutcomeFunnel {
  totalFailedCount: number;
  totalFailedAmount: number;
  attemptedCount: number;
  attemptedAmount: number;
  recoveredCount: number;
  recoveredAmount: number;
}

/**
 * "Revenue Recovered ÷ Revenue at Risk" looks small mainly because most failed-payment revenue
 * was never actually pursued — the engine correctly declined to spend communication/API budget on
 * low-probability leads. That's a deliberate filter, not a recovery failure, and conflating the two
 * makes a healthy recovery engine look weak. This gives the three real stages instead:
 *
 *   1. Total Failed — every payment that ever failed, regardless of what happened to it since.
 *      Note this deliberately does NOT filter by Payment.status="FAILED": a payment that was later
 *      recovered flips to CAPTURED, and excluding those would make the funnel's own "recovered"
 *      stage disappear from the "total" stage it's supposed to be a slice of.
 *   2. Attempted — of those, the ones where at least one attempt actually went beyond STOPPED
 *      (guardrail/score blocked) or REJECTED (merchant declined before execution) — i.e. a real
 *      action was taken or is in flight, not just decided-against.
 *   3. Recovered — of those, the ones where an attempt actually succeeded.
 *
 * The honest recovery rate is stage 3 ÷ stage 2, not stage 3 ÷ stage 1.
 */
export async function getOutcomeFunnel(merchantId: string): Promise<OutcomeFunnel> {
  const [everFailed, attempted, recovered] = await Promise.all([
    prisma.payment.findMany({
      where: { merchantId, failureCategory: { not: "NONE" } },
      select: { amount: true },
    }),
    prisma.payment.findMany({
      where: {
        merchantId,
        failureCategory: { not: "NONE" },
        attempts: { some: { status: { notIn: ["STOPPED", "REJECTED"] } } },
      },
      select: { amount: true },
    }),
    prisma.payment.findMany({
      where: { merchantId, failureCategory: { not: "NONE" }, attempts: { some: { status: "SUCCEEDED" } } },
      select: { amount: true },
    }),
  ]);

  const sum = (rows: { amount: number }[]) => rows.reduce((s, p) => s + p.amount, 0);

  return {
    totalFailedCount: everFailed.length,
    totalFailedAmount: sum(everFailed),
    attemptedCount: attempted.length,
    attemptedAmount: sum(attempted),
    recoveredCount: recovered.length,
    recoveredAmount: sum(recovered),
  };
}

interface ShadowDecision {
  action: RecoveryAction;
  confidence: number;
  cause?: string;
  requiresApproval: boolean;
}

export interface AIShadowRow {
  attemptId: string;
  paymentId: string;
  customerName: string;
  amount: number;
  status: string;
  aiAction: RecoveryAction;
  aiConfidence: number;
  shadowAction: RecoveryAction;
  shadowConfidence: number;
  agreed: boolean;
  actualNetRecovered: number | null;
  estimatedShadowNet: number | null;
  delta: number | null;
  // True when the deterministic engine would have given up entirely (STOP) but the AI chose to
  // act anyway — the specific case that most directly demonstrates AI value-add, as distinct from
  // "AI was more/less cautious than the engine on a case both would have acted on."
  engineWouldHaveMissedThis: boolean;
}

/**
 * The estimated net value of an action nobody actually took, using the exact same probability
 * model the rest of this system already trusts for that action (recoveryScore/100 for
 * RETRY/PAYMENT_LINK, the documented flat rate for ESCALATE, and 0 — no attempt, no revenue — for
 * STOP). This is a projection, not a measured fact: we can never run two different actions on the
 * same real payment, so an estimate is the only honest way to ask "what would the other path have
 * likely netted?" — every consumer of this number must keep presenting it as an estimate.
 */
function estimateShadowNet(action: RecoveryAction, amount: number, recoveryScore: number | null): number {
  if (action === "STOP") return 0;
  if (action === "ESCALATE") return amount * ESCALATION_MANUAL_RESOLUTION_RATE - RECOVERY_COST.ESCALATE;
  const probability = (recoveryScore ?? 30) / 100;
  return amount * probability - RECOVERY_COST[action];
}

/**
 * "Shadow mode" comparison: for every AI-assisted decision, the deterministic engine's own
 * decision was computed alongside it (never acted on — see recoveryOrchestrator). This answers
 * "is the AI actually adding value, or would the deterministic engine alone have done just as
 * well?" instead of just assuming it. Real revenue is compared for AI (what actually happened);
 * the deterministic path is necessarily an estimate (see estimateShadowNet) since it was never run.
 */
export async function getAIShadowComparison(merchantId: string): Promise<{
  totalAIAssisted: number;
  agreedCount: number;
  disagreedCount: number;
  agreementRate: number;
  resolvedDisagreements: number;
  estimatedIncrementalNet: number;
  // Real, actual revenue (not an estimate) recovered on cases the deterministic engine would
  // have given up on entirely (shadow action STOP) — the clearest possible evidence of AI adding
  // value, isolated from the noisier "AI was more/less cautious on a case both would act on" mix
  // that dominates estimatedIncrementalNet.
  revenueFoundByAI: number;
  casesFoundByAI: number;
  rows: AIShadowRow[];
}> {
  const attempts = await prisma.recoveryAttempt.findMany({
    where: { merchantId, usedAI: true, shadowDecision: { not: Prisma.JsonNull } },
    include: { payment: { include: { customer: true } } },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  const rows: AIShadowRow[] = attempts.map((a) => {
    const shadow = a.shadowDecision as unknown as ShadowDecision;
    const agreed = a.action === shadow.action;
    // A genuine recovery outcome, not an infrastructure hiccup — a Razorpay API error (network
    // blip, invalid test data, etc.) lands the attempt at FAILED/API_ERROR too, but that's not a
    // fair reflection of whether the *recommendation* was good, so it doesn't count as "resolved"
    // here (unlike the dashboard's broader recovery-rate metrics, which don't distinguish this).
    // STOPPED counts as resolved too — it's a terminal, certain ₹0 (nothing was ever attempted,
    // and never will be), not an outcome still awaiting resolution. Without this, every AI-chosen
    // STOP showed as "pending" forever, which is wrong in the opposite direction of API_ERROR:
    // that one's a real outcome miscounted as resolved, this one's a certain outcome miscounted as
    // unresolved.
    const isResolved =
      a.status === "SUCCEEDED" || a.status === "STOPPED" || (a.status === "FAILED" && a.outcome === "NOT_RECOVERED");
    const actualNetRecovered = isResolved ? (a.netRecovered ?? 0) : null;
    const estimatedShadowNet = agreed
      ? actualNetRecovered // identical action taken -> the real outcome IS the shadow outcome
      : estimateShadowNet(shadow.action, a.payment.amount, a.payment.recoveryScore);
    const delta =
      !agreed && actualNetRecovered !== null && estimatedShadowNet !== null
        ? actualNetRecovered - estimatedShadowNet
        : null;

    return {
      attemptId: a.id,
      paymentId: a.paymentId,
      customerName: a.payment.customer.name,
      amount: a.payment.amount,
      status: a.status,
      aiAction: a.action,
      aiConfidence: (a.aiOutput as any)?.confidence_score ?? 0,
      shadowAction: shadow.action,
      shadowConfidence: shadow.confidence,
      agreed,
      actualNetRecovered,
      estimatedShadowNet,
      delta,
      engineWouldHaveMissedThis: !agreed && shadow.action === "STOP" && a.action !== "STOP",
    };
  });

  const agreedCount = rows.filter((r) => r.agreed).length;
  const disagreedRows = rows.filter((r) => !r.agreed);
  const resolvedDisagreements = disagreedRows.filter((r) => r.delta !== null);
  const estimatedIncrementalNet = resolvedDisagreements.reduce((sum, r) => sum + (r.delta ?? 0), 0);

  const foundByAI = rows.filter(
    (r) => r.engineWouldHaveMissedThis && r.actualNetRecovered !== null && r.actualNetRecovered > 0,
  );
  const revenueFoundByAI = foundByAI.reduce((sum, r) => sum + (r.actualNetRecovered ?? 0), 0);

  // Surface the clearest evidence first: real recovered revenue the engine would have missed,
  // then by how large the delta is either direction — not just chronological order, which buries
  // the interesting cases under whatever happened most recently.
  const sortedRows = [...rows].sort((a, b) => {
    if (a.engineWouldHaveMissedThis !== b.engineWouldHaveMissedThis) return a.engineWouldHaveMissedThis ? -1 : 1;
    const aAbs = Math.abs(a.delta ?? 0);
    const bAbs = Math.abs(b.delta ?? 0);
    return bAbs - aAbs;
  });

  return {
    totalAIAssisted: rows.length,
    agreedCount,
    disagreedCount: disagreedRows.length,
    agreementRate: rows.length > 0 ? agreedCount / rows.length : 0,
    resolvedDisagreements: resolvedDisagreements.length,
    estimatedIncrementalNet,
    revenueFoundByAI,
    casesFoundByAI: foundByAI.length,
    rows: sortedRows,
  };
}

export interface ConfidenceBucket {
  label: string;
  min: number;
  max: number;
  count: number;
  avgStatedConfidence: number | null;
  actualSuccessRate: number | null;
}

export interface AIConfidenceCalibration {
  totalResolved: number;
  buckets: ConfidenceBucket[];
  avgConfidenceWhenSucceeded: number | null;
  avgConfidenceWhenFailed: number | null;
}

// Bucket boundaries deliberately line up with the one place confidence_score actually does
// something in this app (recoveryOrchestrator's `< 0.6` LOW_AI_CONFIDENCE approval gate), rather
// than arbitrary round numbers — so "Under 60%" here means exactly the same population as the
// cases that already required human approval for low confidence.
const CONFIDENCE_BUCKETS = [
  { label: "Under 60%", min: 0, max: 0.6 },
  { label: "60–85%", min: 0.6, max: 0.85 },
  { label: "85–100%", min: 0.85, max: 1.01 }, // 1.01 so a stated 1.0 falls inside, not excluded
];

/**
 * Checks whether the AI's own self-reported confidence_score means anything, instead of just
 * trusting that it does. The model is told nothing more than "0-1 confidence in this
 * recommendation" (schemas/ai.ts) — no rubric, no calibration requirement — so there's no reason
 * to assume a stated 90% actually succeeds more often than a stated 30% until it's checked against
 * real outcomes.
 *
 * Scoped to non-STOP, resolved attempts only: a STOP has nothing to measure against (nothing was
 * attempted, so there's no real success/failure to compare its confidence to — same reason STOP is
 * excluded from the AI-vs-engine shadow comparison), and an unresolved attempt has no outcome yet
 * to check the stated confidence against either.
 */
export async function getAIConfidenceCalibration(merchantId: string): Promise<AIConfidenceCalibration> {
  const attempts = await prisma.recoveryAttempt.findMany({
    where: { merchantId, usedAI: true, action: { not: "STOP" } },
    select: { status: true, outcome: true, aiOutput: true },
  });

  const resolved = attempts
    .map((a) => ({
      confidence: (a.aiOutput as { confidence_score?: number } | null)?.confidence_score,
      succeeded: a.status === "SUCCEEDED",
      isResolved: a.status === "SUCCEEDED" || (a.status === "FAILED" && a.outcome === "NOT_RECOVERED"),
    }))
    .filter(
      (a): a is { confidence: number; succeeded: boolean; isResolved: true } =>
        a.isResolved && typeof a.confidence === "number",
    );

  const buckets: ConfidenceBucket[] = CONFIDENCE_BUCKETS.map((b) => {
    const inBucket = resolved.filter((r) => r.confidence >= b.min && r.confidence < b.max);
    const successes = inBucket.filter((r) => r.succeeded).length;
    return {
      label: b.label,
      min: b.min,
      max: b.max,
      count: inBucket.length,
      avgStatedConfidence:
        inBucket.length > 0 ? inBucket.reduce((sum, r) => sum + r.confidence, 0) / inBucket.length : null,
      actualSuccessRate: inBucket.length > 0 ? successes / inBucket.length : null,
    };
  });

  const succeededGroup = resolved.filter((r) => r.succeeded);
  const failedGroup = resolved.filter((r) => !r.succeeded);
  const avg = (rows: typeof resolved) =>
    rows.length > 0 ? rows.reduce((sum, r) => sum + r.confidence, 0) / rows.length : null;

  return {
    totalResolved: resolved.length,
    buckets,
    avgConfidenceWhenSucceeded: avg(succeededGroup),
    avgConfidenceWhenFailed: avg(failedGroup),
  };
}
