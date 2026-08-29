import { prisma } from "../db";
import { CustomerRecoveryStats } from "../types";

/**
 * Builds the operational (non-PII) customer stats used by scoring and the AI agent.
 * This is the single source of truth for "data minimization" — nothing beyond these
 * aggregate counters is ever computed here.
 */
export async function getCustomerRecoveryStats(
  customerId: string,
  merchantId: string,
  communicationPeriodHours: number,
  asOf: Date = new Date(),
): Promise<CustomerRecoveryStats> {
  const [successCount, failedCount, attempts, lastPayment] = await Promise.all([
    prisma.payment.count({ where: { customerId, merchantId, status: "CAPTURED" } }),
    prisma.payment.count({ where: { customerId, merchantId, status: "FAILED" } }),
    prisma.recoveryAttempt.findMany({
      where: { merchantId, payment: { customerId } },
      select: { status: true, action: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.payment.findFirst({
      where: { customerId, merchantId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);

  const previousRecoveryAttempts = attempts.length;
  const previousRecoverySuccesses = attempts.filter((a) => a.status === "SUCCEEDED").length;

  const commsWindowMs = communicationPeriodHours * 60 * 60 * 1000;
  const recentlyContacted = attempts.some(
    (a) =>
      a.action === "PAYMENT_LINK" && asOf.getTime() - a.createdAt.getTime() <= commsWindowMs,
  );

  const hoursSinceLastPayment = lastPayment
    ? (asOf.getTime() - lastPayment.createdAt.getTime()) / (1000 * 60 * 60)
    : null;

  return {
    totalSuccessfulPayments: successCount,
    totalFailedPayments: failedCount,
    previousRecoveryAttempts,
    previousRecoverySuccesses,
    recentlyContacted,
    hoursSinceLastPayment,
  };
}

/** Count of customer-facing communications (payment links) sent within the policy window. */
export async function countRecentCommunications(
  customerId: string,
  merchantId: string,
  periodHours: number,
  asOf: Date = new Date(),
): Promise<number> {
  const since = new Date(asOf.getTime() - periodHours * 60 * 60 * 1000);
  return prisma.recoveryAttempt.count({
    where: {
      merchantId,
      action: "PAYMENT_LINK",
      createdAt: { gte: since },
      payment: { customerId },
    },
  });
}
