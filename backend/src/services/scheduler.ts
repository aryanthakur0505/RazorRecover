import { prisma } from "../db";
import { executeAttempt, resolveDueCustomerResponse } from "./executionService";
import { processFailedPayment } from "./recoveryOrchestrator";
import { countRecentCommunications } from "./customerStats";
import { getRetryDelayMinutes } from "./decisionEngine";

const SCAN_INTERVAL_MS = 60_000; // 1 minute — plenty for a hackathon-scale dunning schedule
const COOLDOWN_SCAN_INTERVAL_MS = 5 * 60_000; // 5 minutes — this scan is heavier (fetches every FAILED payment) and the thing it's watching for (a 72h window rolling over) doesn't need minute-level precision
let timer: ReturnType<typeof setInterval> | null = null;
let cooldownTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Polls for RecoveryAttempts that are due (PENDING with scheduledFor in the past) and runs them
 * through executionService — this is what actually enacts the dunning/retry schedule without
 * requiring Redis/BullMQ, which would be over-engineering for v1.
 */
async function scanDueAttempts() {
  try {
    const due = await prisma.recoveryAttempt.findMany({
      where: { status: "PENDING", scheduledFor: { lte: new Date() } },
      take: 50,
    });
    for (const attempt of due) {
      await executeAttempt(attempt.id, {
        ...(attempt.isSimulated ? { simulate: true } : {}),
        ...(attempt.retryOverride ? { retryOverride: true } : {}),
      }).catch((err) => {
        console.error(`[scheduler] failed executing attempt ${attempt.id}:`, err);
      });
    }
  } catch (err) {
    console.error("[scheduler] scan failed:", err);
  }
}

/**
 * Decides simulated PAYMENT_LINK/ESCALATE attempts whose customer-response window (see
 * CUSTOMER_RESPONSE_WINDOW_DAYS) has now passed — until this fires, they sit at EXECUTED
 * ("still recovering"), not won or lost. Same interval as scanDueAttempts since this is exactly
 * the same kind of "is it due yet" check, just against a different status/action.
 */
async function scanDueCustomerResponses() {
  try {
    const due = await prisma.recoveryAttempt.findMany({
      where: {
        status: "EXECUTED",
        action: { in: ["PAYMENT_LINK", "ESCALATE"] },
        isSimulated: true,
        scheduledFor: { lte: new Date() },
      },
      take: 100,
    });
    for (const attempt of due) {
      await resolveDueCustomerResponse(attempt.id).catch((err) => {
        console.error(`[scheduler] failed resolving customer response for attempt ${attempt.id}:`, err);
      });
    }
  } catch (err) {
    console.error("[scheduler] customer-response scan failed:", err);
  }
}

/**
 * Automatically re-engages payments stopped on COMMUNICATION_LIMIT_REACHED once their 72h (or
 * whatever the policy says) window has genuinely rolled over — no merchant click needed, same as
 * any other auto-executed action. Naturally bounded: processFailedPayment recomputes
 * attemptNumber and decisionEngine's own max-retries check still applies, so a payment that
 * keeps failing eventually STOPs for good (see routes/recovery.ts's "exhausted" bucket) instead
 * of cycling through this forever.
 */
async function scanCoolingDownPayments() {
  try {
    const merchants = await prisma.merchant.findMany({ select: { id: true } });
    for (const { id: merchantId } of merchants) {
      const policy = await prisma.recoveryPolicy.findUnique({ where: { merchantId } });
      if (!policy) continue;

      const candidates = await prisma.payment.findMany({
        where: { merchantId, status: "FAILED" },
        include: {
          customer: { select: { id: true } },
          attempts: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      });

      for (const payment of candidates) {
        const latest = payment.attempts[0];
        if (!latest || latest.status !== "STOPPED" || latest.outcome !== "COMMUNICATION_LIMIT_REACHED") continue;

        const commsInPeriod = await countRecentCommunications(
          payment.customer.id,
          merchantId,
          policy.communicationPeriodHours,
        );
        if (commsInPeriod >= policy.maxCommunicationsPerPeriod) continue; // still cooling down

        await processFailedPayment(payment.id, {
          ...(latest.isSimulated ? { simulate: true } : {}),
        }).catch((err) => {
          console.error(`[scheduler] cooldown re-engagement failed for payment ${payment.id}:`, err);
        });
      }
    }
  } catch (err) {
    console.error("[scheduler] cooldown scan failed:", err);
  }
}

/**
 * THE missing piece: a payment whose latest attempt genuinely resolved FAILED (customer never
 * paid, offer expired, whatever) used to just sit there forever -- nothing ever tried it again,
 * even though the policy already has a full 5-stage dunning schedule (retryDelayMinutes) sitting
 * unused past its very first stage. This is what actually fires attempt #2, #3, #4, #5: once the
 * next stage's delay has passed since the last attempt was decided, re-run the same real pipeline
 * (processFailedPayment) that handled attempt #1 -- same classify/score/decide/policy/execute
 * path, nothing special-cased. Naturally bounded exactly like scanCoolingDownPayments: decision-
 * Engine's own `attemptNumber > policy.maxRetries` check STOPs a payment for good once the
 * schedule is exhausted, so this can't cycle forever. A payment that was deliberately STOPPED (or
 * is mid-flight in any other status) is left alone -- only a plain, resolved FAILED counts as "we
 * lost this round, but haven't given up on the payment."
 */
export async function scanFailedForReengagement() {
  try {
    const merchants = await prisma.merchant.findMany({ select: { id: true } });
    for (const { id: merchantId } of merchants) {
      const policy = await prisma.recoveryPolicy.findUnique({ where: { merchantId } });
      if (!policy) continue;

      const candidates = await prisma.payment.findMany({
        where: { merchantId, status: "FAILED" },
        include: { attempts: { orderBy: { attemptNumber: "desc" }, take: 1 } },
      });

      for (const payment of candidates) {
        const latest = payment.attempts[0];
        if (!latest || latest.status !== "FAILED") continue; // not a genuine "lost this round" case
        if (latest.attemptNumber >= policy.maxRetries) continue; // decisionEngine would STOP anyway

        const nextAttemptNumber = latest.attemptNumber + 1;
        const dueAt = new Date(latest.updatedAt.getTime() + getRetryDelayMinutes(policy, nextAttemptNumber) * 60_000);
        if (new Date() < dueAt) continue; // this stage of the dunning schedule hasn't arrived yet

        await processFailedPayment(payment.id, {
          ...(latest.isSimulated ? { simulate: true } : {}),
        }).catch((err) => {
          console.error(`[scheduler] re-engagement failed for payment ${payment.id}:`, err);
        });
      }
    }
  } catch (err) {
    console.error("[scheduler] re-engagement scan failed:", err);
  }
}

export function startScheduler() {
  if (!timer) {
    timer = setInterval(() => {
      scanDueAttempts();
      scanDueCustomerResponses();
    }, SCAN_INTERVAL_MS);
    setTimeout(() => {
      scanDueAttempts();
      scanDueCustomerResponses();
    }, 5_000); // kick off one scan shortly after boot too
    console.log(`[scheduler] started (interval ${SCAN_INTERVAL_MS}ms)`);
  }
  if (!cooldownTimer) {
    cooldownTimer = setInterval(() => {
      scanCoolingDownPayments();
      scanFailedForReengagement();
    }, COOLDOWN_SCAN_INTERVAL_MS);
    setTimeout(() => {
      scanCoolingDownPayments();
      scanFailedForReengagement();
    }, 10_000);
    console.log(`[scheduler] cooldown re-engagement + failed-payment re-engagement started (interval ${COOLDOWN_SCAN_INTERVAL_MS}ms)`);
  }
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  if (cooldownTimer) clearInterval(cooldownTimer);
  cooldownTimer = null;
}
