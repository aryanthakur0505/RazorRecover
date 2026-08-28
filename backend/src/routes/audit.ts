import { Router } from "express";
import { prisma } from "../db";
import { requireSession } from "../middleware/session";
import { asyncHandler } from "../middleware/errorHandler";

export const auditRouter = Router();
auditRouter.use(requireSession);

/** Read-only, append-only audit trail. No route in this app ever updates or deletes a row here. */
auditRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    const logs = await prisma.auditLog.findMany({
      where: { merchantId: req.merchantId },
      orderBy: { timestamp: "desc" },
      take: limit,
    });
    res.json({ logs });
  }),
);
