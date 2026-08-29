import { describe, it, expect } from "vitest";
import { decideDeterministic, shouldEscalateToAI, getRetryDelayMinutes, DecisionInput } from "./decisionEngine";
import { RecoveryPolicy } from "@prisma/client";

const POLICY: RecoveryPolicy = {
  id: "policy_1",
  merchantId: "merchant_1",
  maxRetries: 3,
  maxAutoRecoveryAmount: 500000, // ₹5,000
  maxCommunicationsPerPeriod: 2,
  communicationPeriodHours: 72,
  quietHoursStart: 22,
  quietHoursEnd: 8,
  minRetryIntervalMinutes: 60,
  retryDelayMinutes: [0, 360, 1440] as unknown as RecoveryPolicy["retryDelayMinutes"],
  updatedAt: new Date(),
};

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    category: "TEMPORARY_FAILURE",
    isSuspicious: false,
    score: { score: 80, factors: [] },
    amount: 50000,
    attemptNumber: 1,
    policy: POLICY,
    ...overrides,
  };
}

describe("decideDeterministic", () => {
  it("always ESCALATEs a suspicious payment and requires approval, never RETRY/PAYMENT_LINK", () => {
    const result = decideDeterministic(input({ isSuspicious: true, score: { score: 0, factors: [] } }));
    expect(result.action).toBe("ESCALATE");
    expect(result.requiresApproval).toBe(true);
  });

  it("STOPs once attemptNumber exceeds the policy's maxRetries", () => {
    const result = decideDeterministic(input({ attemptNumber: 4, score: { score: 90, factors: [] } }));
    expect(result.action).toBe("STOP");
  });

  it("RETRYs a high-scoring payment within the auto-recovery amount limit", () => {
    const result = decideDeterministic(input({ score: { score: 85, factors: [] }, amount: 50000 }));
    expect(result.action).toBe("RETRY");
    expect(result.requiresApproval).toBe(false);
  });

  it("requires approval for a high-scoring RETRY above the auto-recovery amount limit", () => {
    const result = decideDeterministic(
      input({ score: { score: 85, factors: [] }, amount: POLICY.maxAutoRecoveryAmount + 1 }),
    );
    expect(result.action).toBe("RETRY");
    expect(result.requiresApproval).toBe(true);
    expect(result.approvalReason).toBe("AMOUNT_EXCEEDS_AUTO_LIMIT");
  });

  it("sends a PAYMENT_LINK for a moderate score", () => {
    const result = decideDeterministic(input({ score: { score: 40, factors: [] } }));
    expect(result.action).toBe("PAYMENT_LINK");
  });

  it("STOPs a low-scoring payment", () => {
    const result = decideDeterministic(input({ score: { score: 10, factors: [] } }));
    expect(result.action).toBe("STOP");
    expect(result.requiresApproval).toBe(false);
  });
});

describe("shouldEscalateToAI", () => {
  it("never escalates a suspicious payment — it's never ambiguous, always STOP/ESCALATE", () => {
    expect(shouldEscalateToAI(input({ isSuspicious: true, score: { score: 50, factors: [] } }))).toBe(false);
  });

  it("escalates a score inside the ambiguous band", () => {
    expect(shouldEscalateToAI(input({ score: { score: 50, factors: [] } }))).toBe(true);
  });

  it("does not escalate a clearly high or low score", () => {
    expect(shouldEscalateToAI(input({ score: { score: 90, factors: [] } }))).toBe(false);
    expect(shouldEscalateToAI(input({ score: { score: 10, factors: [] } }))).toBe(false);
  });

  it("escalates a low-confidence OTHER category even outside the score band", () => {
    expect(shouldEscalateToAI(input({ category: "OTHER", score: { score: 90, factors: [] } }))).toBe(true);
  });

  it("escalates a conflicting signal — a second-plus attempt with a still-decent score", () => {
    expect(shouldEscalateToAI(input({ attemptNumber: 2, score: { score: 55, factors: [] } }))).toBe(true);
    expect(shouldEscalateToAI(input({ attemptNumber: 1, score: { score: 55, factors: [] } }))).toBe(true); // already in-band anyway
    expect(shouldEscalateToAI(input({ attemptNumber: 2, score: { score: 90, factors: [] } }))).toBe(true);
  });
});

describe("getRetryDelayMinutes", () => {
  it("follows the configured dunning schedule per attempt number", () => {
    expect(getRetryDelayMinutes(POLICY, 1)).toBe(0);
    expect(getRetryDelayMinutes(POLICY, 2)).toBe(360);
    expect(getRetryDelayMinutes(POLICY, 3)).toBe(1440);
  });

  it("holds at the last configured stage for any attempt beyond the schedule's length", () => {
    expect(getRetryDelayMinutes(POLICY, 5)).toBe(1440);
  });
});
