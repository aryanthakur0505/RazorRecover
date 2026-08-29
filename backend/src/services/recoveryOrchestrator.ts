import { prisma } from "../db";
import { calculateRecoveryScore } from "./scoring";
import { decideDeterministic, shouldEscalateToAI, getRetryDelayMinutes } from "./decisionEngine";
import { getAIRecommendation } from "./aiAgent";
import { getCustomerRecoveryStats } from "./customerStats";
import { writeAudit } from "./auditService";
import { buildIdempotencyKey, executeAttempt, ExecuteOptions } from "./executionService";
import { DecisionResult } from "../types";

/**
 * Detect → Diagnose → Score → Decide → Guardrail → Execute, orchestrated for a single payment.
 * Called from the webhook handler (live traffic), the scheduler (due retries), and the
 * simulation service (synthetic datasets) — always the same engine, per the plan.
 */
export async function processFailedPayment(paymentId: string, opts: ExecuteOptions = {}) {
  const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  const policy = await prisma.recoveryPolicy.findUniqueOrThrow({ where: { merchantId: payment.merchantId } });

  const attemptNumber = (await prisma.recoveryAttempt.count({ where: { paymentId } })) + 1;
  const asOf = opts.asOf ?? new Date();

  const stats = await getCustomerRecoveryStats(payment.customerId, payment.merchantId, policy.communicationPeriodHours, asOf);
  const hoursSinceFailure = payment.failedAt ? (asOf.getTime() - payment.failedAt.getTime()) / 3600000 : 0;

  const scoreResult = calculateRecoveryScore({
    category: payment.failureCategory,
    amount: payment.amount,
    isSuspicious: payment.isSuspicious,
    hoursSinceFailure,
    stats,
  });

  await prisma.payment.update({
    where: { id: payment.id },
    data: { recoveryScore: scoreResult.score, scoreFactors: scoreResult.factors as any },
  });

  await writeAudit({
    merchantId: payment.merchantId,
    paymentId: payment.id,
    customerId: payment.customerId,
    eventType: "SCORE_CALCULATED",
    recoveryScore: scoreResult.score,
    decisionFactors: scoreResult.factors,
  });

  const decisionInput = {
    category: payment.failureCategory,
    isSuspicious: payment.isSuspicious,
    score: scoreResult,
    amount: payment.amount,
    attemptNumber,
    policy,
  };

  let decision: DecisionResult;
  let usedAI = false;
  let aiOutput: unknown = null;

  const escalate = shouldEscalateToAI(decisionInput);
  if (escalate && !opts.simulate) {
    // Simulation intentionally skips real LLM calls per payment — see simulationService for how
    // it still exercises the "escalated" code path deterministically without 1000 OpenAI calls.
    const ai = await getAIRecommendation(payment.id, payment.merchantId);
    if (ai) {
      usedAI = true;
      aiOutput = ai.recommendation;
      decision = {
        action: ai.recommendation.recommended_action,
        source: "AI",
        confidence: ai.recommendation.confidence_score,
        riskFlags: ai.recommendation.risk_flags,
        decisionFactors: ai.recommendation.decision_factors.map((f) => ({ factor: f.factor, impact: 0, detail: f.detail })),
        recommendedChannel: ai.recommendation.recommended_channel,
        cause: ai.recommendation.cause,
        requiresApproval: payment.amount > policy.maxAutoRecoveryAmount || ai.recommendation.confidence_score < 0.6,
        approvalReason:
          payment.amount > policy.maxAutoRecoveryAmount
            ? "AMOUNT_EXCEEDS_AUTO_LIMIT"
            : ai.recommendation.confidence_score < 0.6
              ? "LOW_AI_CONFIDENCE"
              : undefined,
      };
      await writeAudit({
        merchantId: payment.merchantId,
        paymentId: payment.id,
        customerId: payment.customerId,
        eventType: "AI_RECOMMENDATION",
        aiRecommendation: ai.recommendation,
      });
    } else {
      // AI unavailable or failed to produce valid output — fall back to deterministic engine
      // but force human review since this was flagged ambiguous and we couldn't get reasoning.
      decision = decideDeterministic(decisionInput);
      decision.requiresApproval = true;
      decision.approvalReason = "AI_UNAVAILABLE_ESCALATED";
      decision.riskFlags = [...decision.riskFlags, "ai_unavailable"];
      await writeAudit({
        merchantId: payment.merchantId,
        paymentId: payment.id,
        customerId: payment.customerId,
        eventType: "AI_UNAVAILABLE",
        outcome: "FALLBACK_TO_DETERMINISTIC_WITH_APPROVAL",
      });
    }
  } else {
    decision = decideDeterministic(decisionInput);
  }

  const idempotencyKey = buildIdempotencyKey(payment.id, attemptNumber, decision.action);

  const existing = await prisma.recoveryAttempt.findUnique({ where: { idempotencyKey } });
  if (existing) return existing; // duplicate processing guard

  const delayMinutes = decision.action === "RETRY" ? getRetryDelayMinutes(policy, attemptNumber) : 0;
  const scheduledFor = new Date(asOf.getTime() + delayMinutes * 60000);

  const attempt = await prisma.recoveryAttempt.create({
    data: {
      paymentId: payment.id,
      merchantId: payment.merchantId,
      attemptNumber,
      action: decision.action,
      status: decision.requiresApproval ? "AWAITING_APPROVAL" : "PENDING",
      idempotencyKey,
      usedAI,
      aiOutput: aiOutput as any,
      decisionFactors: decision.decisionFactors as any,
      riskFlags: decision.riskFlags as any,
      requiresApproval: decision.requiresApproval,
      approvalStatus: decision.requiresApproval ? "PENDING" : "NOT_REQUIRED",
      scheduledFor,
      isSimulated: !!opts.simulate,
      // Backdated to the simulated moment (not real "now") so charts/recent-activity spread
      // realistically across the simulated history instead of clustering on the run's real date.
      createdAt: asOf,
    },
  });

  await writeAudit({
    merchantId: payment.merchantId,
    paymentId: payment.id,
    customerId: payment.customerId,
    attemptId: attempt.id,
    eventType: "RECOVERY_ATTEMPT_CREATED",
    action: decision.action,
    idempotencyKey,
    recoveryScore: scoreResult.score,
    decisionFactors: decision.decisionFactors,
    approvalStatus: attempt.approvalStatus,
  });

  if (attempt.status === "PENDING" && scheduledFor.getTime() <= asOf.getTime()) {
    return executeAttempt(attempt.id, opts);
  }

  return attempt;
}
