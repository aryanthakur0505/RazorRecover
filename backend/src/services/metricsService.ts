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
    const isResolved = a.status === "SUCCEEDED" || (a.status === "FAILED" && a.outcome === "NOT_RECOVERED");
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
