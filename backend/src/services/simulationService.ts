import crypto from "crypto";
import { prisma } from "../db";
import { classifyFailure } from "./classification";
import { processFailedPayment } from "./recoveryOrchestrator";
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

const FIRST_NAMES = ["Aarav", "Vivaan", "Ishaan", "Ananya", "Diya", "Kabir", "Meera", "Rohan", "Sara", "Zoya"];
const LAST_NAMES = ["Shah", "Verma", "Iyer", "Nair", "Khan", "Gupta", "Reddy", "Singh", "Das", "Mehta"];

// How many customer chains run concurrently in Phase 3 (see runSimulation) — bounded so we don't
// exceed Neon's pooled-connection limit under a burst of concurrent queries. Each chain still
// does its own customer's failed payments strictly in order, so history accumulates correctly.
const SIMULATION_CONCURRENCY = 25;

function pick<T>(rng: () => number, items: T[]): T {
  return items[Math.floor(rng() * items.length)];
}

function weightedPick(rng: () => number) {
  const r = rng();
  let cumulative = 0;
  for (const entry of FAILURE_WEIGHTS) {
    cumulative += entry.weight;
    if (r <= cumulative) return entry;
  }
  return FAILURE_WEIGHTS[FAILURE_WEIGHTS.length - 1];
}

/** Runs `tasks` with at most `concurrency` in flight at once — a minimal, dependency-free worker
 *  pool. Each task claims the next index as soon as it's free, so faster chains don't wait on
 *  slower ones (no fixed batching), and the results array preserves the tasks' original order. */
async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
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

  // Phase 1: customers, batch-created in one round trip. IDs are generated here (rather than
  // relying on the DB to hand them back) so Phase 2 can reference them immediately — createMany
  // doesn't return the created rows on every Postgres/Prisma combination.
  const customerPoolSize = Math.max(8, Math.ceil(size / 8));
  const customers = Array.from({ length: customerPoolSize }, (_, i) => ({
    id: crypto.randomUUID(),
    merchantId,
    name: `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`,
    email: `sim.${seed}.${i}@example-customer.test`,
    externalRef: `sim-${seed}-${i}`,
    isSimulated: true,
  }));
  await prisma.customer.createMany({ data: customers });

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
    const amount = Math.round((200 + rng() * 15000) * 100); // ₹200 - ₹15,200 in paise
    const isSuccessful = rng() < 0.4;

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

    const failure = weightedPick(rng);
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
      await processFailedPayment(payment.id, { simulate: true, rng: () => recipe.outcomeRoll, asOf: recipe.asOf });

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
  };
}
