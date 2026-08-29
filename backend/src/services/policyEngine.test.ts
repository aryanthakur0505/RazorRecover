import { describe, it, expect } from "vitest";
import { evaluatePolicy, PolicyEvalInput } from "./policyEngine";
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

function evalInput(overrides: Partial<PolicyEvalInput> = {}): PolicyEvalInput {
  return {
    action: "RETRY",
    attemptNumber: 1,
    amount: 50000,
    paymentStatus: "FAILED",
    failureCategory: "TEMPORARY_FAILURE",
    isSuspicious: false,
    communicationsInPeriod: 0,
    minutesSinceLastAttempt: null,
    currentHourLocal: 12, // clear of quiet hours (22:00-08:00)
    policy: POLICY,
    ...overrides,
  };
}

describe("evaluatePolicy — payment state", () => {
  it("blocks any action once the payment is already captured", () => {
    const result = evaluatePolicy(evalInput({ paymentStatus: "CAPTURED" }));
    expect(result.allowed).toBe(false);
    expect(result.stopReason).toBe("PAYMENT_ALREADY_RESOLVED");
  });

  it("blocks any action once the payment is refunded", () => {
    const result = evaluatePolicy(evalInput({ paymentStatus: "REFUNDED" }));
    expect(result.allowed).toBe(false);
    expect(result.stopReason).toBe("PAYMENT_ALREADY_RESOLVED");
  });

  it("allows a still-failed payment through this check", () => {
    const result = evaluatePolicy(evalInput({ paymentStatus: "FAILED" }));
    expect(result.checks.find((c) => c.rule === "payment_state")?.passed).toBe(true);
  });
});

describe("evaluatePolicy — suspicious payments", () => {
  it("blocks RETRY on a suspicious payment", () => {
    const result = evaluatePolicy(evalInput({ action: "RETRY", isSuspicious: true }));
    expect(result.allowed).toBe(false);
    expect(result.stopReason).toBe("SUSPICIOUS_PAYMENT");
  });

  it("blocks PAYMENT_LINK on a suspicious payment", () => {
    const result = evaluatePolicy(evalInput({ action: "PAYMENT_LINK", isSuspicious: true }));
    expect(result.allowed).toBe(false);
    expect(result.stopReason).toBe("SUSPICIOUS_PAYMENT");
  });

  it("always allows STOP and ESCALATE regardless of suspicion", () => {
    expect(evaluatePolicy(evalInput({ action: "STOP", isSuspicious: true })).allowed).toBe(true);
    expect(evaluatePolicy(evalInput({ action: "ESCALATE", isSuspicious: true })).allowed).toBe(true);
  });
});

describe("evaluatePolicy — retry limit", () => {
  it("blocks a RETRY once attemptNumber exceeds maxRetries", () => {
    const result = evaluatePolicy(evalInput({ action: "RETRY", attemptNumber: POLICY.maxRetries + 1 }));
    expect(result.allowed).toBe(false);
    expect(result.stopReason).toBe("MAX_RETRIES_REACHED");
  });

  it("allows a RETRY within the limit", () => {
    const result = evaluatePolicy(evalInput({ action: "RETRY", attemptNumber: POLICY.maxRetries }));
    expect(result.allowed).toBe(true);
  });

  it("does not apply the retry limit to PAYMENT_LINK", () => {
    const result = evaluatePolicy(
      evalInput({ action: "PAYMENT_LINK", attemptNumber: POLICY.maxRetries + 5 }),
    );
    expect(result.checks.some((c) => c.rule === "retry_limit")).toBe(false);
  });
});

describe("evaluatePolicy — amount limit", () => {
  it("requires approval above the auto-recovery limit but does not block outright", () => {
    const result = evaluatePolicy(evalInput({ amount: POLICY.maxAutoRecoveryAmount + 1 }));
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(true);
    expect(result.approvalReason).toBe("AMOUNT_EXCEEDS_AUTO_LIMIT");
  });

  it("does not require approval at or below the limit", () => {
    const result = evaluatePolicy(evalInput({ amount: POLICY.maxAutoRecoveryAmount }));
    expect(result.requiresApproval).toBe(false);
  });
});

describe("evaluatePolicy — communication limit", () => {
  it("blocks a PAYMENT_LINK once the communication limit is reached", () => {
    const result = evaluatePolicy(
      evalInput({ action: "PAYMENT_LINK", communicationsInPeriod: POLICY.maxCommunicationsPerPeriod }),
    );
    expect(result.allowed).toBe(false);
    expect(result.stopReason).toBe("COMMUNICATION_LIMIT_REACHED");
  });

  it("allows a PAYMENT_LINK under the communication limit", () => {
    const result = evaluatePolicy(
      evalInput({ action: "PAYMENT_LINK", communicationsInPeriod: POLICY.maxCommunicationsPerPeriod - 1 }),
    );
    expect(result.allowed).toBe(true);
  });
});

describe("evaluatePolicy — quiet hours (handles the overnight wrap correctly)", () => {
  // policy: quietHoursStart=22, quietHoursEnd=8 -> quiet from 22:00 to 08:00, wrapping midnight
  it.each([
    [23, true],
    [2, true],
    [22, true], // inclusive start
    [8, false], // exclusive end
    [12, false],
    [21, false],
  ])("hour %i -> blocked=%s", (hour, shouldBeQuiet) => {
    const result = evaluatePolicy(evalInput({ action: "RETRY", currentHourLocal: hour }));
    expect(!result.allowed && result.stopReason === "QUIET_HOURS").toBe(shouldBeQuiet);
  });
});

describe("evaluatePolicy — minimum retry interval", () => {
  it("blocks a RETRY that comes in too soon after the last attempt", () => {
    const result = evaluatePolicy(
      evalInput({ action: "RETRY", minutesSinceLastAttempt: POLICY.minRetryIntervalMinutes - 1 }),
    );
    expect(result.allowed).toBe(false);
    expect(result.stopReason).toBe("RETRY_TOO_SOON");
  });

  it("allows a RETRY spaced far enough apart", () => {
    const result = evaluatePolicy(
      evalInput({ action: "RETRY", minutesSinceLastAttempt: POLICY.minRetryIntervalMinutes }),
    );
    expect(result.allowed).toBe(true);
  });

  it("skips the check entirely for a first attempt (no prior attempt to space against)", () => {
    const result = evaluatePolicy(evalInput({ action: "RETRY", minutesSinceLastAttempt: null }));
    expect(result.checks.some((c) => c.rule === "min_retry_interval")).toBe(false);
  });
});

describe("evaluatePolicy — STOP/ESCALATE bypass action-specific guardrails", () => {
  it("never blocks STOP on amount, comms, quiet hours, or retry-count checks", () => {
    const result = evaluatePolicy(
      evalInput({
        action: "STOP",
        amount: 99_999_999,
        communicationsInPeriod: 99,
        currentHourLocal: 2,
        attemptNumber: 99,
      }),
    );
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });
});
