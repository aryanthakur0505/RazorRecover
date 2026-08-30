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
