import { Router } from "express";
import { prisma } from "../db";
import { requireSession } from "../middleware/session";
import { asyncHandler } from "../middleware/errorHandler";
import { policyUpdateSchema } from "../schemas/api";
import { writeAudit } from "../services/auditService";

export const policiesRouter = Router();
policiesRouter.use(requireSession);

policiesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const policy = await prisma.recoveryPolicy.findUnique({ where: { merchantId: req.merchantId } });
    res.json({ policy });
  }),
);

policiesRouter.put(
  "/",
  asyncHandler(async (req, res) => {
    const body = policyUpdateSchema.parse(req.body);
    const policy = await prisma.recoveryPolicy.update({
      where: { merchantId: req.merchantId },
      data: body,
    });
    await writeAudit({
      merchantId: req.merchantId!,
      eventType: "POLICY_UPDATED",
      policyChecks: body,
    });
    res.json({ policy });
  }),
);
