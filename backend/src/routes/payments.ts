import { Router } from "express";
import { prisma } from "../db";
import { requireSession } from "../middleware/session";
import { asyncHandler } from "../middleware/errorHandler";
import { paymentStatusQuerySchema } from "../schemas/api";

export const paymentsRouter = Router();
paymentsRouter.use(requireSession);

paymentsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const status = paymentStatusQuerySchema.parse(req.query.status);
    const payments = await prisma.payment.findMany({
      where: { merchantId: req.merchantId, ...(status ? { status } : {}) },
      include: { customer: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json({ payments });
  }),
);
