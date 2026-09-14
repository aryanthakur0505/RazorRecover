import crypto from "crypto";
import { prisma } from "../db";
import { writeAudit } from "./auditService";
import { createPaymentLink, createRetryOrder, getRazorpayClient } from "./razorpay";
import { evaluatePolicy } from "./policyEngine";
import { countRecentCommunications } from "./customerStats";
import { createEmiOffer, createPromisePlan } from "./emiService";
import {
  RECOVERY_COST,
  AI_COST_PER_CALL_PAISE,
  ESCALATION_MANUAL_RESOLUTION_RATE,
  SIMULATED_RECOVERY_OPTIMISM_BOOST,
  SIMULATED_RECOVERY_MAX_PROBABILITY,
  SIMULATED_RECOVERY_MIN_PROBABILITY,
  PAYMENT_LINK_FRICTION_PENALTY,
  CUSTOMER_RESPONSE_WINDOW_DAYS,
} from "../types";
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
  /** Simulation mode skips real AI calls by default — hundreds of ambiguous payments in one run
   *  would mean hundreds of real Groq calls. This is the one deliberate exception: a single object
   *  shared (by reference) across every payment in the batch, so a bounded sample of genuinely
   *  ambiguous simulated payments still exercises the real AI path — otherwise Shadow Mode data
   *  could only ever come from the hand-run demo seed script, never from simulated traffic, which
   *  defeats the point of measuring it. Decremented in place as it's spent; once it hits 0, the
   *  rest of the batch falls back to deterministic-only, same as before. */
  aiEscalationBudget?: { remaining: number };
  /** Serializes real AI calls during a simulation run (see createMutex) so up to
   *  SIMULATION_CONCURRENCY chains can't all fire a Groq call in the same instant and get
   *  rate-limited. Not set for live traffic — a single webhook doesn't need throttling against
   *  itself. */
  aiCallMutex?: { run<T>(fn: () => Promise<T>): Promise<T> };
  /** Set only by POST /:id/retry-override, for a merchant explicitly retrying a previously-STOPPED
   *  attempt. Bypasses the *soft* guardrails (retry limit, comms limit, quiet hours, retry spacing)
   *  in policyEngine — never payment_state/suspicious_payment/do_not_contact, which stay enforced
   *  regardless. Also forces a fresh human approval step no matter the amount, since overriding a
   *  guardrail on purpose is exactly the case that should get an extra checkpoint, not fewer. */
  retryOverride?: boolean;
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
    doNotContact: payment.customer.doNotContact,
    communicationsInPeriod: commsInPeriod,
    minutesSinceLastAttempt,
    currentHourLocal: asOf.getHours(),
    policy,
    bypassSoftGuardrails: opts.retryOverride,
  });
  if (opts.retryOverride) {
    // A guardrail-bypassing action always gets a fresh human checkpoint, whatever the amount —
    // overriding a guardrail on purpose is exactly the case that should get an extra look, not
    // fewer, regardless of what evaluatePolicy's own amount-limit check happened to conclude.
    evaluation.requiresApproval = true;
  }

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

  // Atomically claim the attempt right before the irreversible part (calling Razorpay and
  // resolving a real outcome) -- found via a live data audit that two concurrent calls for the
  // same attempt (e.g. a double-click on Approve, or a retry racing the scheduler) could both
  // read status="PENDING"/"APPROVED" up at the top of this function before either had written
  // "EXECUTING", both proceed independently (each its own resolveSimulatedOutcome roll), and the
  // second writer would silently overwrite the first outcome -- including leaving payment.status
  // stuck at CAPTURED from an earlier successful roll while the attempt itself flipped to FAILED
  // underneath it. A conditional updateMany makes the claim atomic: only the call whose WHERE
  // clause still matches at write time actually transitions the row, so a losing concurrent call
  // sees 0 rows affected and returns the attempt as everyone else now sees it, instead of
  // resolving it a second time.
  const claim = await prisma.recoveryAttempt.updateMany({
    where: { id: attempt.id, status: { in: ["PENDING", "APPROVED"] } },
    data: { status: "EXECUTING" },
  });
  if (claim.count === 0) {
    return prisma.recoveryAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
  }

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

  // A promise-to-pay was logged at approval time (see POST /:id/approve) instead of resolving
  // this ESCALATE the normal way — reuses the EMI installment-plan machinery with a single
  // installment (see emiService.createPromisePlan). Checked before the plain-ESCALATE branches
  // below so it takes priority regardless of simulate/live: a promise is a merchant's explicit
  // choice on this specific attempt, not a mode default.
  if (attempt.action === "ESCALATE" && attempt.promisedDueDate) {
    await createPromisePlan(
      { ...executed, payment },
      attempt.promisedDueDate,
      attempt.promisedAmount ?? payment.amount,
      { rng: opts.rng },
    );
    return prisma.recoveryAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
  }
  if (attempt.action === "ESCALATE" && !opts.simulate) {
    return executed; // live traffic: stays EXECUTED until a human resolves it out-of-band
  }

  // EMI_PLAN doesn't resolve to a single win/loss the way RETRY/PAYMENT_LINK/ESCALATE do — the
  // merchant only approved *sending an offer*, not a specific plan. createEmiOffer sends it and
  // leaves the plan (and the attempt) at OFFERED/EXECUTED until the customer picks a tenure or
  // the offer window expires — see emiService.resolveOfferIfDue. `backdateForDemo: opts.simulate`
  // is what lets a freshly-simulated dataset show offers at realistic, varied stages (still
  // waiting, already accepted at some tenure, already expired) instead of every offer being
  // brand new.
  if (attempt.action === "EMI_PLAN") {
    await createEmiOffer({ ...executed, payment }, { backdateForDemo: !!opts.simulate, rng: opts.rng });
    return prisma.recoveryAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
  }

  // PAYMENT_LINK and a plain ESCALATE (no promise) both depend on someone else actually acting —
  // the customer clicking the link, or a human's follow-up landing — so deciding won/lost the
  // instant the action is sent is dishonest about timing, even in simulation. Let them sit as
  // "still recovering" for CUSTOMER_RESPONSE_WINDOW_DAYS first, same as a real payment link would.
  // RETRY resolves immediately below (deliberately excluded — see the constant's own doc).
  if (opts.simulate && (attempt.action === "PAYMENT_LINK" || attempt.action === "ESCALATE")) {
    return resolveOrAwaitCustomerResponse(executed, opts.rng ?? Math.random);
  }

  // Simulation resolves the outcome immediately (deterministic seeded probability) — this is now
  // only RETRY, which really does resolve near-instantly via the bank in real life.
  if (opts.simulate) {
    return resolveSimulatedOutcome(executed, opts.rng ?? Math.random);
  }

  // Live mode: outcome resolves later via webhook (order.paid / payment.captured), or via a human
  // manually resolving an escalation (POST /:id/resolve).
  return executed;
}

/**
 * If the customer-response window (from the attempt's own createdAt — already backdated for
 * simulated bulk data, same as every other date in this dataset) has already passed by real
 * "now", resolve it right away — this is what makes a freshly-generated simulation show a
 * realistic mix of still-waiting and already-decided payment links/escalations instead of every
 * one starting fresh. Otherwise, record when to check back (scheduler.ts scans for this) and
 * leave the attempt at EXECUTED — genuinely still recovering, not yet won or lost.
 */
async function resolveOrAwaitCustomerResponse(attempt: RecoveryAttempt, rng: () => number) {
  const respondBy = new Date(attempt.createdAt.getTime() + CUSTOMER_RESPONSE_WINDOW_DAYS * 24 * 3600 * 1000);
  if (new Date() < respondBy) {
    return prisma.recoveryAttempt.update({ where: { id: attempt.id }, data: { scheduledFor: respondBy } });
  }
  return resolveSimulatedOutcome(attempt, rng);
}

/**
 * Scheduler entry point: a simulated PAYMENT_LINK/ESCALATE attempt whose customer-response
 * window has now passed (scheduledFor <= now) gets decided — same probability model as any
 * other simulated outcome, just delayed until a realistic amount of time has actually gone by.
 */
export async function resolveDueCustomerResponse(attemptId: string, rng: () => number = Math.random) {
  const attempt = await prisma.recoveryAttempt.findUniqueOrThrow({ where: { id: attemptId } });
  if (attempt.status !== "EXECUTED") return attempt; // already resolved or moved on — nothing to do
  return resolveSimulatedOutcome(attempt, rng);
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

  // Only fetched when actually needed (not every action calls Razorpay) — and only here, right
  // before the call that needs it, rather than earlier in executeAttempt: RazorpayNotConnectedError
  // for a merchant who hasn't finished setup yet should behave exactly like any other Razorpay call
  // failing (falls into the same catch in executeAttempt → attempt marked FAILED/API_ERROR), not a
  // special case.
  const client = getRazorpayClient(await requireMerchantCredentials(attempt.merchantId));

  if (attempt.action === "RETRY") {
    return createRetryOrder(client, {
      amount: payment.amount,
      currency: payment.currency,
      receipt: attempt.idempotencyKey,
    });
  }
  if (attempt.action === "PAYMENT_LINK") {
    return createPaymentLink(client, {
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

async function requireMerchantCredentials(merchantId: string) {
  return prisma.merchant.findUniqueOrThrow({
    where: { id: merchantId },
    select: { razorpayKeyId: true, razorpayKeySecretEncrypted: true, razorpayWebhookSecretEncrypted: true },
  });
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
  // Defense-in-depth idempotency: refuse to re-resolve an attempt that's already terminal. The
  // real fix for how this could happen at all is executeAttempt's atomic claim above, but
  // resolveLiveOutcome and resolveEscalation both also read-then-call this function without their
  // own atomic claim (a duplicate/out-of-order webhook, or a double click on "Mark Recovered"),
  // so this is a second, independent backstop against the same class of double-resolution that
  // corrupted real data before the claim fix existed -- see git history for the incident.
  if (attempt.status === "SUCCEEDED" || attempt.status === "FAILED") {
    return attempt;
  }

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
  // Recovery score IS the base probability estimate — that's the entire point of computing it —
  // but RETRY and PAYMENT_LINK don't get the same adjustment on top of it anymore, because
  // they're not the same mechanism. RETRY is a frictionless automatic charge, so it keeps the
  // optimism boost (transient-failure self-resolution the raw score doesn't capture). PAYMENT_LINK
  // requires the customer to notice, open, and manually complete it — real dunning data says that
  // converts substantially worse than an auto-charge at the same risk level, so it carries a flat
  // friction penalty instead of a boost (see PAYMENT_LINK_FRICTION_PENALTY in types.ts). Neither
  // touches the recovery score itself or the RETRY/PAYMENT_LINK/STOP decision upstream in
  // decisionEngine.ts — only this simulated dice roll. ESCALATE is different again: its score is
  // deliberately forced to 0 (never auto-recover a suspicious payment), so it can't double as a
  // probability here — that would mean every approved escalation fails by construction. Its
  // outcome instead models a human manually following up after approval;
  // ESCALATION_MANUAL_RESOLUTION_RATE is a flat, documented assumption for that manual-resolution
  // success rate, not derived from score.
  const baseRate = (payment.recoveryScore ?? 30) / 100;
  const probability =
    attempt.action === "ESCALATE"
      ? ESCALATION_MANUAL_RESOLUTION_RATE
      : attempt.action === "PAYMENT_LINK"
        ? Math.max(SIMULATED_RECOVERY_MIN_PROBABILITY, baseRate - PAYMENT_LINK_FRICTION_PENALTY)
        : Math.min(SIMULATED_RECOVERY_MAX_PROBABILITY, baseRate + SIMULATED_RECOVERY_OPTIMISM_BOOST);
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
