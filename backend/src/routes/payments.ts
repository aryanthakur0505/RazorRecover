import { Router } from "express";
import { prisma } from "../db";
import { requireSession } from "../middleware/session";
import { asyncHandler } from "../middleware/errorHandler";

export const paymentsRouter = Router();
paymentsRouter.use(requireSession);

paymentsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const status = req.query.status as string | undefined;
    const payments = await prisma.payment.findMany({
      where: { merchantId: req.merchantId, ...(status ? { status: status as any } : {}) },
      include: { customer: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json({ payments });
  }),
);
