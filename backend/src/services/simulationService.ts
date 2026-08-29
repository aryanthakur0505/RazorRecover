import { prisma } from "../db";
import { classifyFailure } from "./classification";
import { processFailedPayment } from "./recoveryOrchestrator";
import { FailureCategory } from "@prisma/client";

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

export async function runSimulation(
  merchantId: string,
  size: 100 | 500 | 1000,
  seed = 42,
  onProgress?: (processed: number, total: number) => void,
): Promise<SimulationSummary> {
  const rng = mulberry32(seed);

  const customerPoolSize = Math.max(8, Math.ceil(size / 8));
  const customers = [];
  for (let i = 0; i < customerPoolSize; i++) {
    const name = `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`;
    const customer = await prisma.customer.create({
      data: {
        merchantId,
        name,
        email: `sim.${seed}.${i}@example-customer.test`,
        externalRef: `sim-${seed}-${i}`,
        isSimulated: true,
      },
    });
    customers.push(customer);
  }

  // Spread synthetic payments over the past 14 days, oldest first, so that per-customer history
  // (previous attempts, success rate) accumulates realistically as the engine processes them.
  const now = Date.now();
  const paymentSpecs = Array.from({ length: size }, (_, i) => {
    const ageMs = rng() * 14 * 24 * 3600 * 1000;
    return { index: i, createdAt: new Date(now - ageMs) };
  }).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  let paymentsAnalyzed = 0;
  let failedPayments = 0;
  let recoveryCandidates = 0;

  for (const spec of paymentSpecs) {
    const customer = pick(rng, customers);
    const amount = Math.round((200 + rng() * 15000) * 100); // ₹200 - ₹15,200 in paise
    const isSuccessful = rng() < 0.4;

    paymentsAnalyzed++;
    if (onProgress && paymentsAnalyzed % 10 === 0) onProgress(paymentsAnalyzed, size);

    if (isSuccessful) {
      await prisma.payment.create({
        data: {
          merchantId,
          customerId: customer.id,
          amount,
          currency: "INR",
          status: "CAPTURED",
          failureCategory: "NONE",
          isSimulated: true,
          createdAt: spec.createdAt,
        },
      });
      continue;
    }

    const failure = weightedPick(rng);
    const classification = classifyFailure({
      errorReason: failure.reason,
      amount,
      eventType: failure.category === "CHECKOUT_ABANDONED" ? "checkout.abandoned" : "payment.failed",
    });

    const payment = await prisma.payment.create({
      data: {
        merchantId,
        customerId: customer.id,
        amount,
        currency: "INR",
        status: "FAILED",
        failureCategory: classification.category,
        failureReasonRaw: failure.reason,
        isSuspicious: classification.isSuspicious,
        isSimulated: true,
        failedAt: spec.createdAt,
        createdAt: spec.createdAt,
      },
    });

    failedPayments++;
    recoveryCandidates++;

    // Model a realistic detection-to-first-attempt lag (an automated system reacts within hours,
    // not real wall-clock "now" minus a backdated timestamp up to 14 days old) — that mismatch
    // used to force ~half the dataset through the scoring engine's "stale failure" penalty just
    // because of how far back it happened to be backdated for history-spread purposes, which
    // pushed far too many attempts into STOP regardless of how recoverable they actually were.
    const asOf = new Date(spec.createdAt.getTime() + rng() * 6 * 3600 * 1000);

    // Same engine as live traffic — classify → score → decide → guardrail → execute — with the
    // Razorpay call swapped for a synthetic response and the outcome resolved via the seeded RNG.
    await processFailedPayment(payment.id, { simulate: true, rng, asOf });
  }

  onProgress?.(size, size);

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
    paymentsAnalyzed,
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
