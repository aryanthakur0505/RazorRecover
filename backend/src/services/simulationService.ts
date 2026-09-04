import { prisma } from "../db";
import { classifyFailure } from "./classification";
import { processFailedPayment } from "./recoveryOrchestrator";
import { runWithConcurrency, createMutex } from "../utils/concurrency";
import { FailureCategory, Prisma } from "@prisma/client";

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
