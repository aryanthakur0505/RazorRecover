import { z } from "zod";
import { prisma } from "../db";
import { calculateRecoveryScore } from "./scoring";
import { getCustomerRecoveryStats } from "./customerStats";

/**
 * Tool implementations exposed to the OpenAI agent.
 *
 * DATA MINIMIZATION: every function below returns only operational fields the model needs to
 * reason about a recovery decision. None of them ever return card numbers, CVV, bank
 * credentials, Razorpay secrets, passwords, or unnecessary personal identifiers (name/email are
 * intentionally withheld from the model — the backend already knows who the customer is).
 *
 * NOTE on scope: `retry_payment` / `create_payment_link` are deliberately NOT exposed as agent
 * tools. The model's job ends at `submit_recovery_recommendation` (see aiAgent.ts) — actually
 * moving money or creating a Razorpay artifact only ever happens in executionService, after the
 * policy engine (and human approval, if required) has signed off. Giving the model a tool
 * literally named "retry_payment" would blur that boundary even if it were wired to a no-op.
 */

export const toolInputSchemas = {
  get_payment: z.object({ paymentId: z.string() }),
  get_customer_profile: z.object({ customerId: z.string() }),
  get_payment_history: z.object({ customerId: z.string() }),
  get_recovery_history: z.object({ paymentId: z.string() }),
  calculate_recovery_score: z.object({ paymentId: z.string() }),
  flag_payment: z.object({ paymentId: z.string(), reason: z.string() }),
  request_merchant_approval: z.object({ paymentId: z.string(), reason: z.string() }),
};

export type ToolName = keyof typeof toolInputSchemas;

async function get_payment(input: { paymentId: string }, merchantId: string) {
  const payment = await prisma.payment.findFirstOrThrow({
    where: { id: input.paymentId, merchantId },
    select: {
      id: true,
      amount: true,
      currency: true,
      status: true,
      failureCategory: true,
      isSuspicious: true,
      createdAt: true,
      failedAt: true,
    },
  });
  return {
    paymentId: payment.id,
    amount: payment.amount,
    currency: payment.currency,
    status: payment.status,
    failureCategory: payment.failureCategory,
    isSuspicious: payment.isSuspicious,
    paymentTimestamp: payment.createdAt.toISOString(),
    failureTimestamp: payment.failedAt?.toISOString() ?? null,
  };
}

async function get_customer_profile(input: { customerId: string }, merchantId: string) {
  const policy = await prisma.recoveryPolicy.findUnique({ where: { merchantId } });
  const stats = await getCustomerRecoveryStats(
    input.customerId,
    merchantId,
    policy?.communicationPeriodHours ?? 72,
  );
  // Operational fields only — no name, email, phone, or any contact detail.
  return {
    customerId: input.customerId,
    totalSuccessfulPayments: stats.totalSuccessfulPayments,
    totalFailedPayments: stats.totalFailedPayments,
    previousRecoveryAttempts: stats.previousRecoveryAttempts,
    previousRecoverySuccessRate:
      stats.previousRecoveryAttempts > 0
        ? Number((stats.previousRecoverySuccesses / stats.previousRecoveryAttempts).toFixed(2))
        : null,
    recentlyContacted: stats.recentlyContacted,
    hoursSinceLastPayment: stats.hoursSinceLastPayment,
  };
}

async function get_payment_history(input: { customerId: string }, merchantId: string) {
  const payments = await prisma.payment.findMany({
    where: { customerId: input.customerId, merchantId },
    select: { status: true, failureCategory: true, amount: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return {
    customerId: input.customerId,
    recentPayments: payments.map((p) => ({
      status: p.status,
      failureCategory: p.failureCategory,
      amount: p.amount,
      timestamp: p.createdAt.toISOString(),
    })),
  };
}

async function get_recovery_history(input: { paymentId: string }, merchantId: string) {
  const attempts = await prisma.recoveryAttempt.findMany({
    where: { paymentId: input.paymentId, merchantId },
    select: { attemptNumber: true, action: true, status: true, outcome: true, createdAt: true },
    orderBy: { attemptNumber: "asc" },
  });
  return {
    paymentId: input.paymentId,
    attempts: attempts.map((a) => ({
      attemptNumber: a.attemptNumber,
      action: a.action,
      status: a.status,
      outcome: a.outcome,
      timestamp: a.createdAt.toISOString(),
    })),
  };
}

async function calculate_recovery_score(input: { paymentId: string }, merchantId: string) {
  const payment = await prisma.payment.findFirstOrThrow({
    where: { id: input.paymentId, merchantId },
  });
  const policy = await prisma.recoveryPolicy.findUniqueOrThrow({ where: { merchantId } });
  const stats = await getCustomerRecoveryStats(
    payment.customerId,
    merchantId,
    policy.communicationPeriodHours,
  );
  const hoursSinceFailure = payment.failedAt
    ? (Date.now() - payment.failedAt.getTime()) / (1000 * 60 * 60)
    : 0;
  const result = calculateRecoveryScore({
    category: payment.failureCategory,
    amount: payment.amount,
    isSuspicious: payment.isSuspicious,
    hoursSinceFailure,
    stats,
  });
  return { paymentId: input.paymentId, score: result.score, factors: result.factors };
}

// These two are recorded for audit/explanation purposes only — they never touch Razorpay.
async function flag_payment(input: { paymentId: string; reason: string }) {
  return { paymentId: input.paymentId, flagged: true, reason: input.reason };
}

async function request_merchant_approval(input: { paymentId: string; reason: string }) {
  return { paymentId: input.paymentId, approvalRequested: true, reason: input.reason };
}

export const toolImplementations = {
  get_payment,
  get_customer_profile,
  get_payment_history,
  get_recovery_history,
  calculate_recovery_score,
  flag_payment,
  request_merchant_approval,
} as const;
