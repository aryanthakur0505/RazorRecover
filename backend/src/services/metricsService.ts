import { prisma } from "../db";

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
