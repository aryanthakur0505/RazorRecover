import { prisma } from "../db";
import { classifyFailure } from "./classification";
import { processFailedPayment } from "./recoveryOrchestrator";
import { runWithConcurrency, createMutex } from "../utils/concurrency";
import { FailureCategory, Prisma, RecoveryAction } from "@prisma/client";

/** Deterministic seeded PRNG (mulberry32) — same seed always produces the same dataset. */
function mulberry32(seed: number) {
  let a = seed;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FAILURE_WEIGHTS: Array<{ category: FailureCategory; weight: number; reason: string }> = [
  { category: "TEMPORARY_FAILURE", weight: 0.28, reason: "gateway_error" },
  { category: "INSUFFICIENT_FUNDS", weight: 0.22, reason: "insufficient_funds" },
  { category: "CHECKOUT_ABANDONED", weight: 0.22, reason: "checkout.abandoned" },
  { category: "EXPIRED_PAYMENT", weight: 0.12, reason: "card_expired" },
  { category: "SUSPICIOUS_PAYMENT", weight: 0.08, reason: "suspected_fraud" },
  { category: "OTHER", weight: 0.08, reason: "unspecified" },
];

// Real transaction-amount data is right-skewed (many small everyday purchases, a shrinking
// number of larger ones), not flat — a plain `min + rng() * range` draw used to give every
// rupee value from 200 to 15,200 an equal chance, which made mean and median amount nearly
// identical (a tell that the data was synthetic-uniform rather than realistic). Weighted bands
// approximate a realistic shape instead: pick a band, then a uniform value within just that band.
// Modeled on a mid-size Indian e-commerce/subscription merchant — most orders are small, a
// big-ticket order is rare, not evenly likely.
const AMOUNT_BANDS: Array<{ weight: number; min: number; max: number }> = [
  { weight: 0.5, min: 100, max: 1000 }, // everyday small purchases / subscription tiers
  { weight: 0.3, min: 1000, max: 5000 }, // typical order
  { weight: 0.15, min: 5000, max: 20000 }, // higher-ticket purchase
  { weight: 0.05, min: 20000, max: 75000 }, // occasional big-ticket order
];

const FIRST_NAMES = ["Aarav", "Vivaan", "Ishaan", "Ananya", "Diya", "Kabir", "Meera", "Rohan", "Sara", "Zoya"];
const LAST_NAMES = ["Shah", "Verma", "Iyer", "Nair", "Khan", "Gupta", "Reddy", "Singh", "Das", "Mehta"];

// How many customer chains run concurrently in Phase 3 (see runSimulation) — bounded so we don't
// exceed Neon's pooled-connection limit under a burst of concurrent queries. Each chain still
// does its own customer's failed payments strictly in order, so history accumulates correctly.
const SIMULATION_CONCURRENCY = 25;

// How many genuinely-ambiguous simulated payments are allowed to make a real Groq call per run —
// see the aiEscalationBudget doc on ExecuteOptions. Without this, "AI Impact — Shadow Mode" could
// only ever be populated by the hand-run demo seed script, never by simulated traffic, no matter
// how many simulations get run — which defeats the point of the feature. Flat regardless of
// simulation size: this exists to give Shadow Mode a representative, honestly-measured sample,
// not to scale proportionally with payment count.
//
// Measured, not guessed: Groq's free tier caps this model at 8000 tokens/minute, and one AI
// escalation call (system prompt + tool round trips) costs ~800-1000 tokens — observed directly
// from a live run's 429 responses. That's a hard ceiling of ~8 successful calls per minute
// regardless of pacing/concurrency, so this stays comfortably under it rather than spending budget
// on calls 9-20 that would just fail.
const SIMULATION_AI_ESCALATION_CAP = 6;

function pick<T>(rng: () => number, items: T[]): T {
  return items[Math.floor(rng() * items.length)];
}

function weightedPick<T extends { weight: number }>(rng: () => number, items: T[]): T {
  const r = rng();
  let cumulative = 0;
  for (const entry of items) {
    cumulative += entry.weight;
    if (r <= cumulative) return entry;
  }
  return items[items.length - 1];
}

/** Draws one amount (paise) from AMOUNT_BANDS — a band via weightedPick, then a uniform value
 *  within just that band, so the overall shape is right-skewed instead of flat. */
function pickAmount(rng: () => number): number {
  const band = weightedPick(rng, AMOUNT_BANDS);
  const amountRupees = band.min + rng() * (band.max - band.min);
  return Math.round(amountRupees * 100);
}

export interface SimulationSummary {
  size: number;
  seed: number;
  paymentsAnalyzed: number;
  failedPayments: number;
  recoveryCandidates: number;
  recoveryAttemptsExecuted: number;
  successfulRecoveries: number;
  revenueAtRisk: number;
  revenueRecovered: number;
  recoveryCost: number;
  netRecoveredRevenue: number;
  recoveryRate: number;
  netROI: number;
  /** How many simulated payments actually made a real Groq call this run (bounded — see
   *  SIMULATION_AI_ESCALATION_CAP), out of however many were ambiguous enough to qualify. Reported
   *  rather than left implicit — if it's 0, that's worth knowing, not silently swallowed. */
  aiEscalatedCount: number;
}

interface FailedRecipe {
  customerId: string;
  amount: number;
  createdAt: Date;
  category: FailureCategory;
  reason: string;
  isSuspicious: boolean;
  asOf: Date;
  outcomeRoll: number;
}

/**
 * Generates and processes a seeded synthetic dataset through the exact same recovery pipeline as
 * live traffic. Structured in three phases to keep it fast at 1000 payments without touching the
 * result: (1) batch-create customers, (2) a single fast, sequential, no-I/O pass that consumes the
 * RNG to decide every payment's outcome/category/amount — this is the ONLY part that has to be
 * sequential, and it's what makes a given seed reproducible — (3) the actual DB-heavy work
 * (classify → score → decide → guardrail → execute per failed payment), batched where there's no
 * dependency and run with bounded concurrency across customers where there is one (a customer's
 * own payments must still process in order, since their accumulating history affects scoring).
 */
export async function runSimulation(
  merchantId: string,
  size: 100 | 500 | 1000,
  seed = 42,
  onProgress?: (processed: number, total: number) => void,
): Promise<SimulationSummary> {
  // The "500" option is a fixed, hand-specified demo dataset rather than a random simulation —
  // see buildManualDemoDataset for why: 100 and 1000 are still the real random engine below.
  if (size === 500) {
    return buildManualDemoDataset(merchantId, onProgress);
  }

  const rng = mulberry32(seed);

  // Phase 1: one customer per pool slot, keyed on (merchantId, externalRef) and reused across
  // runs rather than always inserted fresh. This is what actually makes "same seed -> same
  // dataset" true: re-running the same seed regenerates the exact same externalRefs, and a plain
  // createMany used to insert a brand-new look-alike row for every one of them on every run —
  // silently splitting one simulated identity's history (payments, notes, do-not-contact status)
  // across multiple disconnected customer records every time anyone clicked "Run Simulation"
  // again (the Command Center has no seed picker, so every click reuses the same default seed).
  //
  // Batched as a find-then-insert-only-the-new-ones pair of round trips rather than one
  // upsert per customer — individually upserting each of up to ~125 customers concurrently was
  // tried first and reliably exhausted Neon's pooled connection limit; this keeps the same
  // O(1)-round-trips shape the original createMany had.
  const customerPoolSize = Math.max(8, Math.ceil(size / 8));
  const customerSpecs = Array.from({ length: customerPoolSize }, (_, i) => ({
    merchantId,
    name: `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`,
    email: `sim.${seed}.${i}@example-customer.test`,
    externalRef: `sim-${seed}-${i}`,
    isSimulated: true,
  }));
  const existingCustomers = await prisma.customer.findMany({
    where: { merchantId, externalRef: { in: customerSpecs.map((s) => s.externalRef) } },
  });
  const existingByRef = new Map(existingCustomers.map((c) => [c.externalRef, c]));
  const newSpecs = customerSpecs.filter((s) => !existingByRef.has(s.externalRef));
  if (newSpecs.length > 0) {
    await prisma.customer.createMany({ data: newSpecs });
  }
  const newlyCreated =
    newSpecs.length > 0
      ? await prisma.customer.findMany({
          where: { merchantId, externalRef: { in: newSpecs.map((s) => s.externalRef) } },
        })
      : [];
  const newByRef = new Map(newlyCreated.map((c) => [c.externalRef, c]));
  const customers = customerSpecs.map((s) => existingByRef.get(s.externalRef) ?? newByRef.get(s.externalRef)!);

  // Phase 2: decide every payment's fate up front, consuming the RNG in one deterministic,
  // sequential, in-memory pass — same seed always produces the same sequence of draws here,
  // regardless of how Phase 3's I/O below happens to interleave.
  const now = Date.now();
  const paymentSpecs = Array.from({ length: size }, (_, i) => {
    const ageMs = rng() * 14 * 24 * 3600 * 1000;
    return { index: i, createdAt: new Date(now - ageMs) };
  }).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const successfulPayments: Prisma.PaymentCreateManyInput[] = [];
  const failedRecipes: FailedRecipe[] = [];

  for (const spec of paymentSpecs) {
    const customer = pick(rng, customers);
    const amount = pickAmount(rng);
    // 0.4 (a flat 60% failure rate) used to be here — not realistic for any real payment
    // gateway; published failure rates for Indian merchants are commonly cited in the 5-20% range
    // depending on payment method (UPI typically lowest, cards/netbanking higher). 0.88 lands at a
    // defensible ~12% failure rate: high enough that a recovery product is still clearly worth
    // having, not so high it reads as a business in crisis.
    const isSuccessful = rng() < 0.88;

    if (isSuccessful) {
      successfulPayments.push({
        merchantId,
        customerId: customer.id,
        amount,
        currency: "INR",
        status: "CAPTURED",
        failureCategory: "NONE",
        isSimulated: true,
        createdAt: spec.createdAt,
      });
      continue;
    }

    const failure = weightedPick(rng, FAILURE_WEIGHTS);
    const classification = classifyFailure({
      errorReason: failure.reason,
      amount,
      eventType: failure.category === "CHECKOUT_ABANDONED" ? "checkout.abandoned" : "payment.failed",
    });

    // Modeling a realistic detection-to-first-attempt lag, and pre-drawing the eventual outcome
    // roll now (used later, if this attempt reaches execution) — both explained further where
    // they're consumed, in Phase 3. Clamped to `now`: for the freshest payments (age ≈ 0, right at
    // the edge of the 14-day spread), adding up to 6 hours of lag would otherwise push asOf — and
    // therefore this attempt's createdAt — into the actual future, which showed up as a "tomorrow"
    // divider in the UI for data that hadn't happened yet.
    const asOf = new Date(Math.min(spec.createdAt.getTime() + rng() * 6 * 3600 * 1000, now));
    const outcomeRoll = rng();

    failedRecipes.push({
      customerId: customer.id,
      amount,
      createdAt: spec.createdAt,
      category: classification.category,
      reason: failure.reason,
      isSuspicious: classification.isSuspicious,
      asOf,
      outcomeRoll,
    });
  }

  // Phase 3a: every successful payment in one round trip — no recovery pipeline needed, so no
  // reason to create these one at a time.
  if (successfulPayments.length > 0) {
    await prisma.payment.createMany({ data: successfulPayments });
  }

  let processed = successfulPayments.length;
  onProgress?.(processed, size);

  // Phase 3b: the actual expensive part — classify/score/decide/guardrail/execute per failed
  // payment, which is inherently a chain of sequential DB round trips per payment. Grouping by
  // customer and running different customers' chains concurrently (bounded — see
  // SIMULATION_CONCURRENCY) is what makes this fast: a customer's own payments still process
  // strictly in order (their history has to accumulate correctly), but the ~100+ customers in a
  // typical run are otherwise fully independent of each other.
  const byCustomer = new Map<string, FailedRecipe[]>();
  for (const recipe of failedRecipes) {
    const list = byCustomer.get(recipe.customerId);
    if (list) list.push(recipe);
    else byCustomer.set(recipe.customerId, [recipe]);
  }

  // Shared by reference across every chain below — see aiEscalationBudget/aiCallMutex on
  // ExecuteOptions. The mutex is what actually keeps the (up to 20) real Groq calls from bursting
  // all at once across SIMULATION_CONCURRENCY chains and getting rate-limited.
  const aiEscalationBudget = { remaining: SIMULATION_AI_ESCALATION_CAP };
  const aiCallMutex = createMutex();

  const chains = Array.from(byCustomer.values()).map((recipes) => async () => {
    for (const recipe of recipes) {
      const payment = await prisma.payment.create({
        data: {
          merchantId,
          customerId: recipe.customerId,
          amount: recipe.amount,
          currency: "INR",
          status: "FAILED",
          failureCategory: recipe.category,
          failureReasonRaw: recipe.reason,
          isSuspicious: recipe.isSuspicious,
          isSimulated: true,
          failedAt: recipe.createdAt,
          createdAt: recipe.createdAt,
        },
      });

      // Same engine as live traffic — classify → score → decide → guardrail → execute — with the
      // Razorpay call swapped for a synthetic response. The outcome roll was already drawn in
      // Phase 2 (not here) specifically so concurrency can't affect which random value a given
      // attempt gets — a fixed replay value keeps a seed's result identical run to run.
      //
      // Caught rather than left to propagate: with runWithConcurrency, one worker's chain
      // rejecting fails the whole batch's Promise.all immediately, but the other still-running
      // chains keep going in the background and can reject *after* that — an unhandled rejection
      // with nothing left awaiting it, which crashes the process. One payment's failure (AI
      // timeout, a transient DB blip) should cost that one payment, not the whole run.
      try {
        await processFailedPayment(payment.id, {
          simulate: true,
          rng: () => recipe.outcomeRoll,
          asOf: recipe.asOf,
          aiEscalationBudget,
          aiCallMutex,
        });
      } catch (err) {
        console.error(`[simulation] payment ${payment.id} failed to process, skipping:`, err);
      }

      processed++;
      if (onProgress && processed % 10 === 0) onProgress(processed, size);
    }
  });

  await runWithConcurrency(chains, SIMULATION_CONCURRENCY);
  onProgress?.(size, size);

  const failedPayments = failedRecipes.length;
  const recoveryCandidates = failedPayments;

  const attempts = await prisma.recoveryAttempt.findMany({
    where: { merchantId, createdAt: { gte: new Date(now - 15 * 24 * 3600 * 1000) } },
  });

  const executed = attempts.filter((a) => ["EXECUTED", "SUCCEEDED", "FAILED"].includes(a.status));
  const succeeded = attempts.filter((a) => a.status === "SUCCEEDED");
  const revenueRecovered = attempts.reduce((sum, a) => sum + (a.revenueRecovered ?? 0), 0);
  const recoveryCost = attempts.reduce((sum, a) => sum + (a.recoveryCost ?? 0), 0);
  const netRecoveredRevenue = revenueRecovered - recoveryCost;

  const failedPaymentRows = await prisma.payment.findMany({
    where: { merchantId, status: "FAILED" },
    select: { amount: true },
  });
  const revenueAtRisk = failedPaymentRows.reduce((sum, p) => sum + p.amount, 0);

  return {
    size,
    seed,
    paymentsAnalyzed: size,
    failedPayments,
    recoveryCandidates,
    recoveryAttemptsExecuted: executed.length,
    successfulRecoveries: succeeded.length,
    revenueAtRisk,
    revenueRecovered,
    recoveryCost,
    netRecoveredRevenue,
    recoveryRate: recoveryCandidates > 0 ? succeeded.length / recoveryCandidates : 0,
    netROI: recoveryCost > 0 ? netRecoveredRevenue / recoveryCost : 0,
    aiEscalatedCount: SIMULATION_AI_ESCALATION_CAP - aiEscalationBudget.remaining,
  };
}

// ---------------------------------------------------------------------------------------------
// Deterministic "500" demo dataset
// ---------------------------------------------------------------------------------------------
//
// The 100/1000 options above stay a real random simulation. "500" is deliberately a fixed,
// hand-specified dataset instead — chosen (by explicit request, for demo-recording purposes)
// over a random one because a demo needs a *reliable* story every take, not a different roll of
// the dice each time: 400 payments succeed outright; of the 100 that fail (~₹10,00,000 total), 10
// are never attempted (~₹1,20,000, blocked before any action), and 90 are attempted (~₹8,80,000)
// — 55 recovered (~₹5,70,000), 35 not recovered. Of those 90: 10 are AI-assisted (~₹70,000, a
// healthy, honest mix of agreements and wins) and 6 are EMI-plan cases (~₹1,80,000). No live Groq
// calls are made — the AI reasoning text is authored, not model output — since re-running this on
// every take would burn real API quota for a result that has to be reliable regardless.
//
// Clears this merchant's own data first (never another merchant's), then rebuilds it fresh, so
// clicking "Run Simulation" → 500 always lands on exactly this shape.

function daysAgo(n: number, jitterHours = 12): Date {
  return new Date(Date.now() - n * 24 * 3600 * 1000 - Math.random() * jitterHours * 3600 * 1000);
}

/** Splits `total` into `n` positive integers summing exactly to it, with natural-looking variance
 *  rather than n identical values. */
function splitSum(total: number, n: number): number[] {
  if (n === 1) return [total];
  const weights = Array.from({ length: n }, () => 0.4 + Math.random() * 1.2);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const parts = weights.map((w) => Math.max(1, Math.round((w / weightSum) * total)));
  const drift = total - parts.reduce((a, b) => a + b, 0);
  parts[parts.length - 1] += drift;
  if (parts[parts.length - 1] < 1) {
    parts[0] += parts[parts.length - 1] - 1;
    parts[parts.length - 1] = 1;
  }
  return parts;
}

function rupeesToPaise(r: number): number {
  return Math.round(r * 100);
}

/** Nudges a round target (e.g. 120000) by a small random percentage so the totals it feeds into
 *  land on realistic, un-round figures (₹1,18,540, not a suspiciously exact ₹1,20,000) — and
 *  differ a little from one run to the next, the way real revenue numbers never repeat exactly. */
function jitterTarget(base: number, pct = 0.04): number {
  const jitter = 1 + (Math.random() * 2 - 1) * pct;
  return Math.round(base * jitter);
}

const MANUAL_CATEGORY_POOL: FailureCategory[] = ["TEMPORARY_FAILURE", "CHECKOUT_ABANDONED", "EXPIRED_PAYMENT", "OTHER"];
function pickManualCategory(exclude: FailureCategory[] = []): FailureCategory {
  const pool = MANUAL_CATEGORY_POOL.filter((c) => !exclude.includes(c));
  return pool[Math.floor(Math.random() * pool.length)];
}

const MANUAL_COST: Record<string, number> = { RETRY: 200, PAYMENT_LINK: 150, ESCALATE: 15000, EMI_PLAN: 500, STOP: 0 };

export async function buildManualDemoDataset(
  merchantId: string,
  onProgress?: (processed: number, total: number) => void,
): Promise<SimulationSummary> {
  const TOTAL = 500;
  let processed = 0;
  const tick = (n: number) => {
    processed += n;
    onProgress?.(Math.min(processed, TOTAL), TOTAL);
  };

  // A genuinely-FAILED attempt at attemptNumber < maxRetries is exactly what the background
  // scheduler's re-engagement scan (scheduler.ts#scanFailedForReengagement) looks for — and with
  // this dataset's backdated timestamps, that retry looks overdue the moment it's created, so the
  // scheduler silently attempts it again for real a few minutes later, quietly turning "35 not
  // recovered" into something else. Every attempt this function marks FAILED for good (not meant
  // to be retried again) uses attemptNumber = maxRetries so that check always skips it — same as
  // a real payment whose dunning schedule has genuinely run out.
  const policy = await prisma.recoveryPolicy.findUniqueOrThrow({ where: { merchantId } });
  const EXHAUSTED_ATTEMPT_NUMBER = policy.maxRetries;

  // Clear this merchant's own prior data (never another merchant's) so re-running always lands
  // on exactly the same shape rather than accumulating on top of whatever was there before.
  await prisma.installment.deleteMany({ where: { plan: { merchantId } } });
  await prisma.installmentPlan.deleteMany({ where: { merchantId } });
  await prisma.auditLog.deleteMany({ where: { merchantId } });
  await prisma.recoveryAttempt.deleteMany({ where: { merchantId } });
  await prisma.customerNote.deleteMany({ where: { merchantId } });
  await prisma.payment.deleteMany({ where: { merchantId } });
  await prisma.customer.deleteMany({ where: { merchantId } });

  const customerCount = 70;
  const customers: { id: string }[] = [];
  for (let i = 0; i < customerCount; i++) {
    const name = `${pick(() => Math.random(), FIRST_NAMES)} ${pick(() => Math.random(), LAST_NAMES)}`;
    const c = await prisma.customer.create({
      data: {
        merchantId,
        name,
        email: `manual.${i}@example-customer.test`,
        externalRef: `manual-${i}`,
        isSimulated: true,
      },
    });
    customers.push(c);
  }
  const nextCustomer = (() => {
    let i = 0;
    return () => customers[i++ % customers.length];
  })();

  let auditBatch: Prisma.AuditLogCreateManyInput[] = [];
  async function flushAudit() {
    if (auditBatch.length) {
      await prisma.auditLog.createMany({ data: auditBatch });
      auditBatch = [];
    }
  }
  function audit(entry: Omit<Prisma.AuditLogCreateManyInput, "merchantId">) {
    auditBatch.push({ merchantId, ...entry });
  }

  // ---- 1) 400 payments that succeeded outright ----
  const successPayments = Array.from({ length: 400 }, () => {
    const roll = Math.random();
    const amount =
      roll < 0.55
        ? rupeesToPaise(100 + Math.random() * 900)
        : roll < 0.85
          ? rupeesToPaise(1000 + Math.random() * 4000)
          : roll < 0.97
            ? rupeesToPaise(5000 + Math.random() * 15000)
            : rupeesToPaise(20000 + Math.random() * 55000);
    return {
      merchantId,
      customerId: nextCustomer().id,
      amount,
      currency: "INR",
      status: "CAPTURED" as const,
      failureCategory: "NONE" as const,
      isSimulated: true,
      createdAt: daysAgo(Math.random() * 14),
    };
  });
  await prisma.payment.createMany({ data: successPayments });
  tick(400);

  // ---- 2) 10 failed payments, never attempted (~₹1,20,000) ----
  const stopAmountsPaise = splitSum(rupeesToPaise(jitterTarget(120000)), 10);
  const stopReasons = ["SCORE_TOO_LOW", "SUSPICIOUS_PAYMENT_BLOCKED", "DO_NOT_CONTACT", "MAX_RETRIES_EXCEEDED", "QUIET_HOURS"];
  for (let i = 0; i < 10; i++) {
    const isSuspicious = i < 2;
    const category: FailureCategory = isSuspicious ? "SUSPICIOUS_PAYMENT" : pickManualCategory(["SUSPICIOUS_PAYMENT"]);
    const createdAt = daysAgo(Math.random() * 14);
    const amount = stopAmountsPaise[i];
    const payment = await prisma.payment.create({
      data: {
        merchantId,
        customerId: nextCustomer().id,
        amount,
        currency: "INR",
        status: "FAILED",
        failureCategory: category,
        failureReasonRaw: isSuspicious ? "suspected_fraud" : "unspecified",
        isSuspicious,
        recoveryScore: Math.floor(Math.random() * 15),
        failedAt: createdAt,
        createdAt,
      },
    });
    const reason = isSuspicious ? "SUSPICIOUS_PAYMENT_BLOCKED" : stopReasons[i % stopReasons.length];
    const attempt = await prisma.recoveryAttempt.create({
      data: {
        paymentId: payment.id,
        merchantId,
        attemptNumber: 1,
        action: "STOP",
        status: "STOPPED",
        requiresApproval: false,
        approvalStatus: "NOT_REQUIRED",
        outcome: reason,
        idempotencyKey: `${payment.id}:1:STOP`,
        createdAt,
      },
    });
    audit({ paymentId: payment.id, customerId: payment.customerId, attemptId: attempt.id, eventType: "SCORE_CALCULATED", amount, recoveryScore: payment.recoveryScore, timestamp: createdAt });
    audit({ paymentId: payment.id, customerId: payment.customerId, attemptId: attempt.id, eventType: "POLICY_BLOCKED", action: "STOP", outcome: reason, amount, timestamp: createdAt });
    tick(1);
  }

  // ---- 3) 90 attempted failed payments (~₹8,80,000): 55 recovered / 35 not ----
  //
  // Of the 55 recovered, only a portion is already-resolved when the dataset is built — the rest
  // sits in AWAITING_APPROVAL (a real, un-executed "Needs Approval" queue) specifically so there's
  // a live bulk-approve moment: Revenue Recovered starts around ~₹3,00,000-ish and climbs to the
  // full ~₹5,70,000 target as those get approved (individually or via "select all matching this
  // filter"). Pending rows use only RETRY/PAYMENT_LINK (never ESCALATE, whose 40% manual-resolution
  // rate isn't score-driven) and a high recoveryScore, so approving them is *likely* — not
  // guaranteed, since the real synthetic-outcome dice roll still runs — to actually succeed.
  type PlainRow = { amount: number; succeeded: boolean; action: RecoveryAction; pending: boolean };
  const plainRows: PlainRow[] = [];
  const plainImmediateAmounts = splitSum(rupeesToPaise(jitterTarget(190000)), 25);
  const plainPendingAmounts = splitSum(rupeesToPaise(jitterTarget(200000)), 20);
  const plainFailedAmounts = splitSum(rupeesToPaise(jitterTarget(242000)), 29);
  const plainActions: RecoveryAction[] = ["RETRY", "PAYMENT_LINK", "ESCALATE"];
  const reliableActions: RecoveryAction[] = ["RETRY", "PAYMENT_LINK"];
  plainImmediateAmounts.forEach((amount, i) => plainRows.push({ amount, succeeded: true, action: plainActions[i % 3], pending: false }));
  plainPendingAmounts.forEach((amount, i) => plainRows.push({ amount, succeeded: true, action: reliableActions[i % 2], pending: true }));
  plainFailedAmounts.forEach((amount, i) => plainRows.push({ amount, succeeded: false, action: plainActions[i % 3], pending: false }));

  for (const row of plainRows) {
    const createdAt = daysAgo(Math.random() * 14);
    const category = pickManualCategory(["SUSPICIOUS_PAYMENT"]);
    // Pending rows get a deliberately high score — it's the same recoveryScore the real
    // synthetic-outcome roll reads, so this is what makes approving them likely to succeed.
    const score = row.pending
      ? 70 + Math.floor(Math.random() * 20)
      : row.succeeded
        ? 45 + Math.floor(Math.random() * 40)
        : 15 + Math.floor(Math.random() * 30);
    const payment = await prisma.payment.create({
      data: {
        merchantId,
        customerId: nextCustomer().id,
        amount: row.amount,
        currency: "INR",
        status: "FAILED",
        failureCategory: category,
        failureReasonRaw: "unspecified",
        isSimulated: true,
        recoveryScore: score,
        scoreFactors: [
          { factor: "failure_category", detail: `Base score for ${category} failures.`, impact: row.succeeded ? 30 : 15 },
          { factor: "customer_track_record", detail: "Customer history factored into this score.", impact: row.succeeded ? 15 : -5 },
        ],
        failedAt: createdAt,
        createdAt,
      },
    });
    const cost = MANUAL_COST[row.action];

    if (row.pending) {
      const attempt = await prisma.recoveryAttempt.create({
        data: {
          paymentId: payment.id,
          merchantId,
          attemptNumber: 1,
          action: row.action,
          status: "AWAITING_APPROVAL",
          isSimulated: true,
          requiresApproval: true,
          approvalStatus: "PENDING",
          idempotencyKey: `${payment.id}:1:${row.action}`,
          createdAt,
        },
      });
      audit({ paymentId: payment.id, customerId: payment.customerId, attemptId: attempt.id, eventType: "SCORE_CALCULATED", amount: row.amount, recoveryScore: score, timestamp: createdAt });
      audit({ paymentId: payment.id, customerId: payment.customerId, attemptId: attempt.id, eventType: "APPROVAL_REQUIRED", action: row.action, amount: row.amount, approvalStatus: "PENDING", timestamp: createdAt });
      tick(1);
      continue;
    }

    const revenueRecovered = row.succeeded ? row.amount : 0;
    const netRecovered = revenueRecovered - cost;
    const attempt = await prisma.recoveryAttempt.create({
      data: {
        paymentId: payment.id,
        merchantId,
        attemptNumber: row.succeeded ? 1 : EXHAUSTED_ATTEMPT_NUMBER,
        action: row.action,
        status: row.succeeded ? "SUCCEEDED" : "FAILED",
        requiresApproval: false,
        approvalStatus: "NOT_REQUIRED",
        executedAt: createdAt,
        revenueRecovered,
        recoveryCost: cost,
        netRecovered,
        outcome: row.succeeded ? "RECOVERED" : "NOT_RECOVERED",
        razorpayResponse: { demo: true, note: "Seed data — no real Razorpay call was made." },
        idempotencyKey: `${payment.id}:1:${row.action}`,
        createdAt,
      },
    });
    audit({ paymentId: payment.id, customerId: payment.customerId, attemptId: attempt.id, eventType: "SCORE_CALCULATED", amount: row.amount, recoveryScore: score, timestamp: createdAt });
    audit({ paymentId: payment.id, customerId: payment.customerId, attemptId: attempt.id, eventType: "ACTION_EXECUTED", action: row.action, amount: row.amount, timestamp: createdAt });
    audit({ paymentId: payment.id, customerId: payment.customerId, attemptId: attempt.id, eventType: "OUTCOME_RECORDED", outcome: row.succeeded ? "RECOVERED" : "NOT_RECOVERED", revenueRecovered, recoveryCost: cost, netRecovered, timestamp: createdAt });
    tick(1);
  }

  // ---- 10 AI-assisted (6 succeeded / 4 failed), ~₹70,000 total ----
  interface AICase {
    amountRupees: number;
    succeeded: boolean;
    action: RecoveryAction;
    shadowAction: RecoveryAction;
    aiConfidence: number;
    shadowConfidence: number;
    cause: string;
  }
  const aiCases: AICase[] = [
    { amountRupees: 6500, succeeded: true, action: "PAYMENT_LINK", shadowAction: "PAYMENT_LINK", aiConfidence: 0.85, shadowConfidence: 0.8, cause: "Payment failed due to a temporary gateway error." },
    { amountRupees: 7200, succeeded: true, action: "RETRY", shadowAction: "RETRY", aiConfidence: 0.78, shadowConfidence: 0.75, cause: "Checkout was abandoned before completion." },
    { amountRupees: 8100, succeeded: true, action: "ESCALATE", shadowAction: "ESCALATE", aiConfidence: 0.72, shadowConfidence: 0.68, cause: "Conflicting signals across recent attempts." },
    { amountRupees: 9800, succeeded: true, action: "ESCALATE", shadowAction: "STOP", aiConfidence: 0.8, shadowConfidence: 0.7, cause: "Low score, but strong customer history suggested a human follow-up was worth trying anyway." },
    { amountRupees: 5400, succeeded: true, action: "PAYMENT_LINK", shadowAction: "RETRY", aiConfidence: 0.75, shadowConfidence: 0.6, cause: "Card-level failure made a fresh payment link more promising than a raw retry." },
    { amountRupees: 5000, succeeded: true, action: "RETRY", shadowAction: "RETRY", aiConfidence: 0.9, shadowConfidence: 0.85, cause: "Clear temporary failure with a strong prior success rate." },
    { amountRupees: 7500, succeeded: false, action: "PAYMENT_LINK", shadowAction: "PAYMENT_LINK", aiConfidence: 0.65, shadowConfidence: 0.62, cause: "Ambiguous failure reason with mixed customer history." },
    { amountRupees: 6000, succeeded: false, action: "PAYMENT_LINK", shadowAction: "RETRY", aiConfidence: 0.6, shadowConfidence: 0.55, cause: "Uncertain whether the card or the checkout flow was the real problem." },
    { amountRupees: 8500, succeeded: false, action: "ESCALATE", shadowAction: "ESCALATE", aiConfidence: 0.55, shadowConfidence: 0.58, cause: "Repeated failures suggested a deeper issue needing a human look." },
    { amountRupees: 6000, succeeded: false, action: "STOP", shadowAction: "ESCALATE", aiConfidence: 0.88, shadowConfidence: 0.5, cause: "High amount plus a poor recent track record outweighed the case for escalating." },
  ];
  for (const c of aiCases) {
    const createdAt = daysAgo(Math.random() * 14);
    const amount = rupeesToPaise(jitterTarget(c.amountRupees, 0.06));
    const payment = await prisma.payment.create({
      data: {
        merchantId,
        customerId: nextCustomer().id,
        amount,
        currency: "INR",
        status: "FAILED",
        failureCategory: "OTHER",
        failureReasonRaw: "unspecified",
        recoveryScore: Math.round((c.succeeded ? 55 : 30) + Math.random() * 15),
        failedAt: createdAt,
        createdAt,
      },
    });
    const cost = MANUAL_COST[c.action] ?? 200;
    const revenueRecovered = c.action !== "STOP" && c.succeeded ? amount : 0;
    const netRecovered = c.action === "STOP" ? null : revenueRecovered - cost;
    const status = c.action === "STOP" ? "STOPPED" : c.succeeded ? "SUCCEEDED" : "FAILED";
    const aiOutput = {
      cause: c.cause,
      risk_flags: c.action === "STOP" ? ["high_amount", "poor_track_record"] : ["ambiguous_failure"],
      confidence_score: c.aiConfidence,
      decision_factors: [
        { factor: "failure_category", detail: "Base score for this failure category." },
        { factor: "customer_track_record", detail: "Recent payment history factored into the call." },
        { factor: "time_since_failure", detail: "Time elapsed since the failure affects retry timing." },
      ],
      recommended_action: c.action,
      recommended_channel: c.action === "STOP" ? "NONE" : c.action,
    };
    const attempt = await prisma.recoveryAttempt.create({
      data: {
        paymentId: payment.id,
        merchantId,
        attemptNumber: status === "FAILED" ? EXHAUSTED_ATTEMPT_NUMBER : 1,
        action: c.action,
        status,
        usedAI: true,
        aiOutput,
        decisionFactors: aiOutput.decision_factors,
        riskFlags: aiOutput.risk_flags,
        shadowDecision: { action: c.shadowAction, confidence: c.shadowConfidence },
        requiresApproval: true,
        approvalStatus: "APPROVED",
        executedAt: createdAt,
        revenueRecovered: c.action === "STOP" ? null : revenueRecovered,
        recoveryCost: c.action === "STOP" ? null : cost,
        netRecovered,
        outcome: c.action === "STOP" ? "STOPPED_BY_POLICY" : c.succeeded ? "RECOVERED" : "NOT_RECOVERED",
        razorpayResponse: c.action === "STOP" ? undefined : { demo: true, note: "Seed data — no real Razorpay call was made." },
        idempotencyKey: `${payment.id}:1:${c.action}`,
        createdAt,
      },
    });
    audit({ paymentId: payment.id, customerId: payment.customerId, attemptId: attempt.id, eventType: "SCORE_CALCULATED", amount, recoveryScore: payment.recoveryScore, timestamp: createdAt });
    audit({ paymentId: payment.id, customerId: payment.customerId, attemptId: attempt.id, eventType: "AI_RECOMMENDATION", aiRecommendation: aiOutput, action: c.action, amount, timestamp: createdAt });
    audit({ paymentId: payment.id, customerId: payment.customerId, attemptId: attempt.id, eventType: c.action === "STOP" ? "POLICY_BLOCKED" : "ACTION_EXECUTED", action: c.action, amount, timestamp: createdAt });
    if (c.action !== "STOP") {
      audit({ paymentId: payment.id, customerId: payment.customerId, attemptId: attempt.id, eventType: "OUTCOME_RECORDED", outcome: c.succeeded ? "RECOVERED" : "NOT_RECOVERED", revenueRecovered, recoveryCost: cost, netRecovered, timestamp: createdAt });
    }
    tick(1);
  }

  // ---- 6 EMI-plan cases (4 active, 2 expired), ~₹1,80,000 total ----
  const emiActiveAmounts = splitSum(rupeesToPaise(jitterTarget(140000)), 4);
  const emiExpiredAmounts = splitSum(rupeesToPaise(jitterTarget(40000)), 2);
  const TENURES = [6, 12, 24];
  const ANNUAL_RATE_BPS = 1500;

  async function createEmiCase(amount: number, succeeding: boolean) {
    const createdAt = daysAgo(3 + Math.random() * 10);
    const customer = nextCustomer();
    const payment = await prisma.payment.create({
      data: {
        merchantId,
        customerId: customer.id,
        amount,
        currency: "INR",
        status: "FAILED",
        failureCategory: "INSUFFICIENT_FUNDS",
        failureReasonRaw: "insufficient_funds",
        recoveryScore: succeeding ? 38 : 30,
        failedAt: createdAt,
        createdAt,
      },
    });
    const cost = MANUAL_COST.EMI_PLAN;
    const revenueRecovered = succeeding ? amount : 0;
    const attempt = await prisma.recoveryAttempt.create({
      data: {
        paymentId: payment.id,
        merchantId,
        attemptNumber: succeeding ? 1 : EXHAUSTED_ATTEMPT_NUMBER,
        action: "EMI_PLAN",
        status: succeeding ? "SUCCEEDED" : "FAILED",
        requiresApproval: false,
        approvalStatus: "NOT_REQUIRED",
        executedAt: createdAt,
        revenueRecovered,
        recoveryCost: cost,
        netRecovered: revenueRecovered - cost,
        outcome: succeeding ? "RECOVERED" : "NOT_RECOVERED",
        idempotencyKey: `${payment.id}:1:EMI_PLAN`,
        createdAt,
      },
    });

    if (succeeding) {
      const tenureMonths = TENURES[Math.floor(Math.random() * TENURES.length)];
      const totalInterest = Math.round(((amount * ANNUAL_RATE_BPS) / 10000) * (tenureMonths / 12));
      const totalPayable = amount + totalInterest;
      const monthlyAmount = Math.round(totalPayable / tenureMonths);
      const plan = await prisma.installmentPlan.create({
        data: {
          merchantId,
          paymentId: payment.id,
          customerId: customer.id,
          attemptId: attempt.id,
          principalAmount: amount,
          tenureMonths,
          annualInterestRateBps: ANNUAL_RATE_BPS,
          totalInterest,
          totalPayable,
          monthlyAmount,
          status: "ACTIVE",
          startDate: createdAt,
        },
      });
      const paidCount = Math.max(1, Math.floor(tenureMonths * (0.25 + Math.random() * 0.4)));
      const installments = Array.from({ length: tenureMonths }, (_, i) => ({
        planId: plan.id,
        installmentNumber: i + 1,
        dueDate: new Date(createdAt.getTime() + (i + 1) * 30 * 24 * 3600 * 1000),
        amount: i === tenureMonths - 1 ? totalPayable - monthlyAmount * (tenureMonths - 1) : monthlyAmount,
        status: i < paidCount ? ("PAID" as const) : ("PENDING" as const),
        paidAt: i < paidCount ? new Date(createdAt.getTime() + (i + 1) * 30 * 24 * 3600 * 1000) : null,
      }));
      await prisma.installment.createMany({ data: installments });
    } else {
      await prisma.installmentPlan.create({
        data: {
          merchantId,
          paymentId: payment.id,
          customerId: customer.id,
          attemptId: attempt.id,
          principalAmount: amount,
          annualInterestRateBps: ANNUAL_RATE_BPS,
          status: "EXPIRED",
          startDate: createdAt,
          offerExpiresAt: new Date(createdAt.getTime() + 7 * 24 * 3600 * 1000),
        },
      });
    }

    audit({ paymentId: payment.id, customerId: payment.customerId, attemptId: attempt.id, eventType: "SCORE_CALCULATED", amount, recoveryScore: payment.recoveryScore, timestamp: createdAt });
    audit({ paymentId: payment.id, customerId: payment.customerId, attemptId: attempt.id, eventType: "ACTION_EXECUTED", action: "EMI_PLAN", amount, timestamp: createdAt });
    audit({ paymentId: payment.id, customerId: payment.customerId, attemptId: attempt.id, eventType: "OUTCOME_RECORDED", outcome: succeeding ? "RECOVERED" : "NOT_RECOVERED", revenueRecovered, recoveryCost: cost, netRecovered: revenueRecovered - cost, timestamp: createdAt });
    tick(1);
  }
  for (const amount of emiActiveAmounts) await createEmiCase(amount, true);
  for (const amount of emiExpiredAmounts) await createEmiCase(amount, false);

  await flushAudit();
  onProgress?.(TOTAL, TOTAL);

  const attempts = await prisma.recoveryAttempt.findMany({ where: { merchantId } });
  const executed = attempts.filter((a) => ["EXECUTED", "SUCCEEDED", "FAILED"].includes(a.status));
  const succeeded = attempts.filter((a) => a.status === "SUCCEEDED");
  const revenueRecovered = attempts.reduce((sum, a) => sum + (a.revenueRecovered ?? 0), 0);
  const recoveryCost = attempts.reduce((sum, a) => sum + (a.recoveryCost ?? 0), 0);
  const netRecoveredRevenue = revenueRecovered - recoveryCost;
  const failedPaymentRows = await prisma.payment.findMany({ where: { merchantId, status: "FAILED" }, select: { amount: true } });
  const revenueAtRisk = failedPaymentRows.reduce((sum, p) => sum + p.amount, 0);
  const recoveryCandidates = failedPaymentRows.length;

  return {
    size: 500,
    seed: 0,
    paymentsAnalyzed: 500,
    failedPayments: recoveryCandidates,
    recoveryCandidates,
    recoveryAttemptsExecuted: executed.length,
    successfulRecoveries: succeeded.length,
    revenueAtRisk,
    revenueRecovered,
    recoveryCost,
    netRecoveredRevenue,
    recoveryRate: recoveryCandidates > 0 ? succeeded.length / recoveryCandidates : 0,
    netROI: recoveryCost > 0 ? netRecoveredRevenue / recoveryCost : 0,
    aiEscalatedCount: aiCases.length,
  };
}
