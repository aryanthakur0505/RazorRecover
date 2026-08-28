import { Router } from "express";
import { requireSession } from "../middleware/session";
import { asyncHandler } from "../middleware/errorHandler";
import { env } from "../env";
import {
  getDashboardMetrics,
  getRevenueOverTime,
  getRecoveryByFailureType,
  getRecoveryByAction,
  getAttemptOutcomeBreakdown,
} from "../services/metricsService";
import { prisma } from "../db";

export const metricsRouter = Router();
metricsRouter.use(requireSession);

metricsRouter.get(
  "/dashboard",
  asyncHandler(async (req, res) => {
    const metrics = await getDashboardMetrics(req.merchantId!);
    res.json({ ...metrics, agentStatus: env.aiEnabled ? "ONLINE" : "UNAVAILABLE" });
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
