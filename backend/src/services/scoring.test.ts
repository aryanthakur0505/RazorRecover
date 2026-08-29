import { describe, it, expect } from "vitest";
import { calculateRecoveryScore, ScoringInput } from "./scoring";
import { CustomerRecoveryStats } from "../types";

const NEW_CUSTOMER: CustomerRecoveryStats = {
  totalSuccessfulPayments: 0,
  totalFailedPayments: 0,
  previousRecoveryAttempts: 0,
  previousRecoverySuccesses: 0,
  recentlyContacted: false,
  hoursSinceLastPayment: null,
};

function score(overrides: Partial<ScoringInput> = {}) {
  const input: ScoringInput = {
    category: "TEMPORARY_FAILURE",
    amount: 50000, // ₹500
    isSuspicious: false,
    hoursSinceFailure: 4, // inside the "sweet spot" so it doesn't interact with other assertions
    stats: NEW_CUSTOMER,
    ...overrides,
  };
  return calculateRecoveryScore(input);
}

describe("calculateRecoveryScore", () => {
  it("forces score to exactly 0 for a suspicious payment, regardless of every other input", () => {
    const result = score({
      isSuspicious: true,
      category: "TEMPORARY_FAILURE",
      hoursSinceFailure: 4,
      stats: { ...NEW_CUSTOMER, totalSuccessfulPayments: 100, totalFailedPayments: 0 },
    });
    expect(result.score).toBe(0);
  });

  it("ranks base category scores in the documented order", () => {
    const categories: [ScoringInput["category"], number][] = [
      ["TEMPORARY_FAILURE", 70],
      ["CHECKOUT_ABANDONED", 55],
      ["INSUFFICIENT_FUNDS", 50],
      ["EXPIRED_PAYMENT", 40],
      ["OTHER", 35],
    ];
    for (const [category, base] of categories) {
      // hoursSinceFailure=4 -> +10 freshness bonus, so expected = base + 10
      expect(score({ category }).score).toBe(base + 10);
    }
  });

  it("rewards a customer with a strong payment success history", () => {
    const good = score({ stats: { ...NEW_CUSTOMER, totalSuccessfulPayments: 9, totalFailedPayments: 1 } });
    const bad = score({ stats: { ...NEW_CUSTOMER, totalSuccessfulPayments: 1, totalFailedPayments: 9 } });
    expect(good.score).toBeGreaterThan(bad.score);
  });

  it("penalizes each prior recovery attempt, capped at -30", () => {
    // previousRecoverySuccesses = previousRecoveryAttempts (perfect history) holds the separate
    // historical-success-rate factor constant at +10, isolating just the per-attempt penalty.
    const one = score({ stats: { ...NEW_CUSTOMER, previousRecoveryAttempts: 1, previousRecoverySuccesses: 1 } });
    const four = score({ stats: { ...NEW_CUSTOMER, previousRecoveryAttempts: 4, previousRecoverySuccesses: 4 } });
    const ten = score({ stats: { ...NEW_CUSTOMER, previousRecoveryAttempts: 10, previousRecoverySuccesses: 10 } });
    // baseline (0 prior attempts) for TEMPORARY_FAILURE @ hoursSinceFailure=4 is 80
    expect(one.score).toBe(80); // -10 capped penalty, +10 perfect-history bonus cancels out
    expect(four.score).toBe(60); // -30 (would be -40 uncapped) +10
    expect(ten.score).toBe(60); // still capped at -30, same as four
  });

  it("applies the correct time-decay band for every documented threshold", () => {
    // Regression test for the real-time-vs-simulated-time bug: these bands must be driven
    // entirely by the passed-in hoursSinceFailure, nothing else.
    expect(score({ hoursSinceFailure: 0.1 }).score).toBe(65); // 70 - 5 (very fresh)
    expect(score({ hoursSinceFailure: 24 }).score).toBe(80); // 70 + 10 (sweet spot)
    expect(score({ hoursSinceFailure: 100 }).score).toBe(65); // 70 - 5 (48h-168h)
    expect(score({ hoursSinceFailure: 200 }).score).toBe(50); // 70 - 20 (>168h / stale)
  });

  it("applies a high-amount penalty above ₹10,000", () => {
    const small = score({ amount: 500000 }); // ₹5,000
    const large = score({ amount: 1500000 }); // ₹15,000
    expect(small.score - large.score).toBe(10);
  });

  it("penalizes a recently-contacted customer", () => {
    const notContacted = score({ stats: { ...NEW_CUSTOMER, recentlyContacted: false } });
    const contacted = score({ stats: { ...NEW_CUSTOMER, recentlyContacted: true } });
    expect(notContacted.score - contacted.score).toBe(8);
  });

  it("never returns a score outside [0, 100]", () => {
    const floor = score({
      category: "OTHER",
      amount: 2000000,
      hoursSinceFailure: 500,
      stats: { ...NEW_CUSTOMER, previousRecoveryAttempts: 10, previousRecoverySuccesses: 0, recentlyContacted: true },
    });
    expect(floor.score).toBeGreaterThanOrEqual(0);

    const ceiling = score({
      category: "TEMPORARY_FAILURE",
      amount: 100,
      hoursSinceFailure: 24,
      stats: { ...NEW_CUSTOMER, totalSuccessfulPayments: 1000, totalFailedPayments: 0, previousRecoveryAttempts: 0 },
    });
    expect(ceiling.score).toBeLessThanOrEqual(100);
  });

  it("returns a signed factor for every contribution, so the score is always explainable", () => {
    const result = score({ stats: { ...NEW_CUSTOMER, totalSuccessfulPayments: 5, totalFailedPayments: 5 } });
    expect(result.factors.length).toBeGreaterThan(0);
    for (const f of result.factors) {
      expect(typeof f.impact).toBe("number");
      expect(f.detail.length).toBeGreaterThan(0);
    }
  });
});
