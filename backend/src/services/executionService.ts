import crypto from "crypto";
import { prisma } from "../db";
import { writeAudit } from "./auditService";
import { createPaymentLink, createRetryOrder } from "./razorpay";
import { evaluatePolicy } from "./policyEngine";
import { countRecentCommunications } from "./customerStats";
import { RECOVERY_COST, AI_COST_PER_CALL_PAISE, ESCALATION_MANUAL_RESOLUTION_RATE } from "../types";
import { RecoveryAction, RecoveryAttempt } from "@prisma/client";

export function buildIdempotencyKey(paymentId: string, attemptNumber: number, action: RecoveryAction) {
  return crypto.createHash("sha256").update(`${paymentId}:${attemptNumber}:${action}`).digest("hex");
}

const MAX_EXECUTION_RETRIES = 3;
const EXECUTION_RETRY_BACKOFF_MINUTES = [5, 15, 45];

/**
 * Distinguishes "Razorpay/the network hiccupped, try again shortly" from "this call is wrong and
 * always will be" — a rate limit or a 500 says nothing about whether the action itself was valid,
 * so it shouldn't burn the attempt the same way a real 4xx (bad request, auth failure) does.
 */
function isRetryableError(err: unknown): boolean {
  const e = err as { statusCode?: number; code?: string } | null;
  if (!e) return false;
  if (typeof e.statusCode === "number") return e.statusCode === 429 || e.statusCode >= 500;
  if (typeof e.code === "string") {
    return ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN"].includes(e.code);
  }
  return false;
}

export interface ExecuteOptions {
  /** Simulation mode never calls the real Razorpay API — used by the seeded dataset generator so
   *  1000-payment simulations don't hammer Test Mode or require anyone to actually pay. Also set
   *  by the approve/reject/execute routes when acting on a `RecoveryAttempt.isSimulated` row,
   *  since there's no real customer behind it for a webhook to ever resolve it otherwise. */
  simulate?: boolean;
  /** Deterministic RNG for simulation outcome resolution (seeded PRNG from simulationService).
   *  Omitted when a human approves a simulated attempt later — that resolution isn't part of
   *  the original seeded batch, so it just uses Math.random. */
  rng?: () => number;
  /** The "current time" to evaluate policy windows (quiet hours, retry spacing, comms limits)
   *  against. Defaults to real time; the simulation engine passes the backdated simulated
   *  moment instead, since its dataset spans up to 14 days built in a few real seconds. */
  asOf?: Date;
}

/**
 * Executes one (already-decided, already-approved-if-required) RecoveryAttempt.
 * Re-runs every guardrail check right before touching Razorpay — this is the single choke
 * point all financial actions must pass through, whether they originated from the deterministic
 * engine, the AI agent, or a human approval.
 */
export async function executeAttempt(attemptId: string, opts: ExecuteOptions = {}) {
  const attempt = await prisma.recoveryAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: { payment: { include: { customer: true } } },
  });

  // Idempotency: if this attempt has already moved past PENDING/APPROVED, do nothing.
  if (!["PENDING", "APPROVED"].includes(attempt.status)) {
    return attempt;
  }

  const payment = attempt.payment;
  const asOf = opts.asOf ?? new Date();

  // `policy` and `lastAttempt` don't depend on each other — running them concurrently instead of
  // one-at-a-time collapses 2 sequential round trips into 1, which matters a lot when each round
  // trip is a real network hop away rather than a local call. `commsInPeriod` genuinely does need
  // policy.communicationPeriodHours first, so it can't join that same batch.
  const [policy, lastAttempt] = await Promise.all([
    prisma.recoveryPolicy.findUniqueOrThrow({ where: { merchantId: attempt.merchantId } }),
    prisma.recoveryAttempt.findFirst({
      where: { paymentId: payment.id, id: { not: attempt.id }, status: { in: ["EXECUTED", "SUCCEEDED", "FAILED"] } },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const minutesSinceLastAttempt = lastAttempt
    ? Math.floor((asOf.getTime() - lastAttempt.createdAt.getTime()) / 60000)
    : null;

  const commsInPeriod = await countRecentCommunications(
    payment.customerId,
    attempt.merchantId,
    policy.communicationPeriodHours,
    asOf,
  );

  const evaluation = evaluatePolicy({
    action: attempt.action,
    attemptNumber: attempt.attemptNumber,
    amount: payment.amount,
    paymentStatus: payment.status,
    failureCategory: payment.failureCategory,
    isSuspicious: payment.isSuspicious,
    communicationsInPeriod: commsInPeriod,
    minutesSinceLastAttempt,
    currentHourLocal: asOf.getHours(),
    policy,
  });

  if (!evaluation.allowed) {
    const stopped = await prisma.recoveryAttempt.update({
      where: { id: attempt.id },
      data: { status: "STOPPED", policyChecks: evaluation.checks as any, outcome: evaluation.stopReason },
    });
    await writeAudit({
      merchantId: attempt.merchantId,
      paymentId: payment.id,
      customerId: payment.customerId,
      attemptId: attempt.id,
      eventType: "POLICY_BLOCKED",
      policyChecks: evaluation.checks,
      action: attempt.action,
      outcome: evaluation.stopReason,
    });
    return stopped;
  }

  if (evaluation.requiresApproval && attempt.approvalStatus !== "APPROVED") {
    const awaiting = await prisma.recoveryAttempt.update({
      where: { id: attempt.id },
      data: {
        status: "AWAITING_APPROVAL",
        requiresApproval: true,
        approvalStatus: attempt.approvalStatus === "REJECTED" ? "REJECTED" : "PENDING",
        policyChecks: evaluation.checks as any,
      },
    });
    await writeAudit({
      merchantId: attempt.merchantId,
      paymentId: payment.id,
      customerId: payment.customerId,
      attemptId: attempt.id,
      eventType: "APPROVAL_REQUIRED",
      policyChecks: evaluation.checks,
      action: attempt.action,
      approvalStatus: "PENDING",
    });
    return awaiting;
  }

  await prisma.recoveryAttempt.update({ where: { id: attempt.id }, data: { status: "EXECUTING" } });

  let razorpayResponse: unknown = null;
  try {
    razorpayResponse = await performAction(attempt, opts);
  } catch (err) {
    if (isRetryableError(err) && attempt.executionRetries < MAX_EXECUTION_RETRIES) {
      const backoffMinutes = EXECUTION_RETRY_BACKOFF_MINUTES[attempt.executionRetries] ?? 45;
      const retryAt = new Date(asOf.getTime() + backoffMinutes * 60000);
      const retried = await prisma.recoveryAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "PENDING",
          executionRetries: attempt.executionRetries + 1,
          scheduledFor: retryAt,
        },
      });
      await writeAudit({
        merchantId: attempt.merchantId,
        paymentId: payment.id,
        customerId: payment.customerId,
        attemptId: attempt.id,
        eventType: "ACTION_EXECUTION_RETRY_SCHEDULED",
        action: attempt.action,
        outcome: `TRANSIENT_ERROR_RETRY_${attempt.executionRetries + 1}_OF_${MAX_EXECUTION_RETRIES}`,
        apiResult: { error: String(err) },
      });
      return retried; // scheduler picks this back up at retryAt — never counted as a final failure
    }

    const failed = await prisma.recoveryAttempt.update({
      where: { id: attempt.id },
      data: { status: "FAILED", outcome: "API_ERROR", razorpayResponse: { error: String(err) } },
    });
    await writeAudit({
      merchantId: attempt.merchantId,
      paymentId: payment.id,
      customerId: payment.customerId,
      attemptId: attempt.id,
      eventType: "ACTION_EXECUTION_FAILED",
      action: attempt.action,
      outcome: "API_ERROR",
      apiResult: { error: String(err) },
    });
    return failed;
  }

  const executed = await prisma.recoveryAttempt.update({
    where: { id: attempt.id },
    data: {
      status: "EXECUTED",
      executedAt: new Date(),
      razorpayResponse: razorpayResponse as any,
      policyChecks: evaluation.checks as any,
    },
  });

  await writeAudit({
    merchantId: attempt.merchantId,
    paymentId: payment.id,
    customerId: payment.customerId,
    attemptId: attempt.id,
    eventType: "ACTION_EXECUTED",
    action: attempt.action,
    apiResult: razorpayResponse,
    policyChecks: evaluation.checks,
  });

  // STOP has no external outcome to wait for.
  if (attempt.action === "STOP") {
    return prisma.recoveryAttempt.update({ where: { id: attempt.id }, data: { status: "STOPPED", outcome: "STOPPED_BY_POLICY" } });
  }
  if (attempt.action === "ESCALATE" && !opts.simulate) {
    return executed; // live traffic: stays EXECUTED until a human resolves it out-of-band
  }

  // Simulation resolves the outcome immediately (deterministic seeded probability) — including
  // an approved ESCALATE, since there's no real customer behind a simulated payment for a human's
  // manual follow-up to ever produce a webhook. Without this, every simulated escalation a human
  // approves would sit at EXECUTED forever.
  if (opts.simulate) {
    return resolveSimulatedOutcome(executed, opts.rng ?? Math.random);
  }

  // Live mode: outcome resolves later via webhook (order.paid / payment.captured).
  return executed;
}

async function performAction(
  attempt: RecoveryAttempt & { payment: { amount: number; currency: string; customer: { name: string; email: string } } },
  opts: ExecuteOptions,
) {
  const { payment } = attempt;

  if (opts.simulate) {
    // Synthetic but shaped like a real Razorpay response, so downstream code paths are identical.
    if (attempt.action === "RETRY") {
      return { simulated: true, id: `order_sim_${attempt.id}`, status: "created" };
    }
    if (attempt.action === "PAYMENT_LINK") {
      return { simulated: true, id: `plink_sim_${attempt.id}`, short_url: `https://rzp.io/sim/${attempt.id}`, status: "created" };
    }
    return { simulated: true };
  }

  if (attempt.action === "RETRY") {
    return createRetryOrder({
      amount: payment.amount,
      currency: payment.currency,
      receipt: attempt.idempotencyKey,
    });
  }
  if (attempt.action === "PAYMENT_LINK") {
    return createPaymentLink({
      amount: payment.amount,
      currency: payment.currency,
      customerName: payment.customer.name,
      customerEmail: payment.customer.email,
      description: "Complete your payment",
      referenceId: attempt.idempotencyKey,
    });
  }
  return null;
}

/**
 * Single source of truth for "what does a resolved outcome cost/pay out, and what does it write
 * down" — shared by simulated, live-webhook, and manually-resolved (escalation) outcomes so the
 * revenue math can't drift between the three paths.
 */
async function finalizeOutcome(
  attempt: RecoveryAttempt,
  payment: { id: string; amount: number; customerId: string },
  succeeded: boolean,
  extraAudit?: Record<string, unknown>,
) {
  const cost = RECOVERY_COST[attempt.action] + (attempt.usedAI ? AI_COST_PER_CALL_PAISE : 0);
  const revenueRecovered = succeeded ? payment.amount : 0;
  const netRecovered = revenueRecovered - cost;

  const updated = await prisma.recoveryAttempt.update({
    where: { id: attempt.id },
    data: {
      status: succeeded ? "SUCCEEDED" : "FAILED",
      outcome: succeeded ? "RECOVERED" : "NOT_RECOVERED",
      revenueRecovered,
      recoveryCost: cost,
      netRecovered,
    },
  });

  if (succeeded) {
    await prisma.payment.update({ where: { id: payment.id }, data: { status: "CAPTURED" } });
  }

  await writeAudit({
    merchantId: attempt.merchantId,
    paymentId: payment.id,
    customerId: payment.customerId,
    attemptId: attempt.id,
    eventType: "OUTCOME_RECORDED",
    action: attempt.action,
    outcome: updated.outcome ?? undefined,
    revenueRecovered,
    recoveryCost: cost,
    netRecovered,
    ...extraAudit,
  });

  return updated;
}

async function resolveSimulatedOutcome(attempt: RecoveryAttempt, rng: () => number) {
  const payment = await prisma.payment.findUniqueOrThrow({ where: { id: attempt.paymentId } });
  // Recovery score IS the probability estimate for automated RETRY/PAYMENT_LINK — that's the
  // entire point of computing it. ESCALATE is different: its score is deliberately forced to 0
  // (never auto-recover a suspicious payment), so it can't double as a probability here — that
  // would mean every approved escalation fails by construction. Its outcome instead models a
  // human manually following up after approval; ESCALATION_MANUAL_RESOLUTION_RATE is a flat,
  // documented assumption for that manual-resolution success rate, not derived from the score.
  const probability =
    attempt.action === "ESCALATE" ? ESCALATION_MANUAL_RESOLUTION_RATE : (payment.recoveryScore ?? 30) / 100;
  const succeeded = rng() < probability;
  return finalizeOutcome(attempt, payment, succeeded);
}

/**
 * Called from the webhook handler when a real `order.paid` / `payment.captured` /
 * `payment.failed` (post-retry) event arrives, to finalize whichever EXECUTED attempt it
 * corresponds to. Idempotent: attempts already resolved are left untouched.
 */
export async function resolveLiveOutcome(paymentId: string, succeeded: boolean) {
  const attempt = await prisma.recoveryAttempt.findFirst({
    where: { paymentId, status: "EXECUTED" },
    orderBy: { createdAt: "desc" },
  });
  if (!attempt) return null;

  const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  return finalizeOutcome(attempt, payment, succeeded);
}

/**
 * Manual resolution for a live (non-simulated) ESCALATE attempt — the only action with no
 * Razorpay call and therefore no webhook that could ever tell us what happened. A merchant
 * follows up with the customer out-of-band and records the result here. Only valid on an
 * EXECUTED escalation; already-resolved attempts are rejected rather than silently overwritten.
 */
export async function resolveEscalation(attemptId: string, succeeded: boolean, note?: string) {
  const attempt = await prisma.recoveryAttempt.findUniqueOrThrow({ where: { id: attemptId } });

  if (attempt.action !== "ESCALATE") {
    throw new Error("Only ESCALATE attempts can be manually resolved.");
  }
  if (attempt.status !== "EXECUTED") {
    throw new Error(`Attempt is ${attempt.status}, not awaiting manual resolution.`);
  }

  const payment = await prisma.payment.findUniqueOrThrow({ where: { id: attempt.paymentId } });
  return finalizeOutcome(attempt, payment, succeeded, note ? { apiResult: { manualResolutionNote: note } } : undefined);
}
