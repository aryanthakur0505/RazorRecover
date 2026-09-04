import { Router } from "express";
import { requireSession } from "../middleware/session";
import { asyncHandler } from "../middleware/errorHandler";
import { env } from "../env";
import {
  getDashboardMetrics,
  getPaymentsOverview,
  getRevenueOverTime,
  getRecoveryByFailureType,
  getRecoveryByAction,
  getAttemptOutcomeBreakdown,
  getAIShadowComparison,
  getOutcomeFunnel,
  getAIConfidenceCalibration,
} from "../services/metricsService";
import { prisma } from "../db";

export const metricsRouter = Router();
metricsRouter.use(requireSession);

metricsRouter.get(
  "/dashboard",
  asyncHandler(async (req, res) => {
    const [metrics, paymentsOverview] = await Promise.all([
      getDashboardMetrics(req.merchantId!),
      getPaymentsOverview(req.merchantId!),
    ]);
    res.json({ ...metrics, ...paymentsOverview, agentStatus: env.aiEnabled ? "ONLINE" : "UNAVAILABLE" });
  }),
);

metricsRouter.get(
  "/charts",
  asyncHandler(async (req, res) => {
    const [revenueOverTime, byFailureType, byAction, outcomeBreakdown] = await Promise.all([
      getRevenueOverTime(req.merchantId!),
      getRecoveryByFailureType(req.merchantId!),
      getRecoveryByAction(req.merchantId!),
      getAttemptOutcomeBreakdown(req.merchantId!),
    ]);
    res.json({ revenueOverTime, byFailureType, byAction, outcomeBreakdown });
  }),
);

/** "Shadow mode": how the AI's recommendations compare to what the deterministic engine alone
 *  would have decided on the same input — see metricsService.getAIShadowComparison for the full
 *  explanation of what's measured versus estimated here. */
metricsRouter.get(
  "/ai-comparison",
  asyncHandler(async (req, res) => {
    const comparison = await getAIShadowComparison(req.merchantId!);
    res.json(comparison);
  }),
);

/** "Revenue at Risk" vs "Revenue Recovered" alone invites comparing recovered money against money
 *  that was never actually pursued — see metricsService.getOutcomeFunnel for the full reasoning.
 *  This gives the three real stages (Total Failed → Attempted → Recovered) so that distinction is
 *  visible instead of implied. */
metricsRouter.get(
  "/outcome-funnel",
  asyncHandler(async (req, res) => {
    const funnel = await getOutcomeFunnel(req.merchantId!);
    res.json(funnel);
  }),
);

/** Checks whether the AI's own self-reported confidence_score actually predicts real outcomes —
 *  see metricsService.getAIConfidenceCalibration for why this can't be assumed by default. */
metricsRouter.get(
  "/ai-calibration",
  asyncHandler(async (req, res) => {
    const calibration = await getAIConfidenceCalibration(req.merchantId!);
    res.json(calibration);
  }),
);

metricsRouter.get(
  "/recent-activity",
  asyncHandler(async (req, res) => {
    const attempts = await prisma.recoveryAttempt.findMany({
      where: { merchantId: req.merchantId },
      include: { payment: { include: { customer: true } } },
      orderBy: { updatedAt: "desc" },
      take: 15,
    });
    res.json({ attempts });
  }),
);
