import { Router } from "express";
import { prisma } from "../db";
import { requireSession } from "../middleware/session";
import { asyncHandler } from "../middleware/errorHandler";
import { approvalDecisionSchema } from "../schemas/api";
import { executeAttempt } from "../services/executionService";
import { writeAudit } from "../services/auditService";

export const recoveryRouter = Router();
recoveryRouter.use(requireSession);

/** Recovery opportunities queue — RecoveryAttempts joined with their payment/customer, scoped
 *  strictly to the session's merchant. Never trusts a merchantId from the client. */
recoveryRouter.get(
  "/opportunities",
  asyncHandler(async (req, res) => {
    const status = req.query.status as string | undefined;
    const attempts = await prisma.recoveryAttempt.findMany({
      where: {
        merchantId: req.merchantId,
        ...(status ? { status: status as any } : {}),
      },
      include: {
        payment: { include: { customer: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json({ attempts });
  }),
);

recoveryRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const attempt = await prisma.recoveryAttempt.findFirst({
      where: { id: req.params.id, merchantId: req.merchantId },
      include: { payment: { include: { customer: true } }, auditLogs: { orderBy: { timestamp: "asc" } } },
    });
    if (!attempt) {
      res.status(404).json({ error: "Recovery attempt not found" });
      return;
    }
    res.json({ attempt });
  }),
);

recoveryRouter.post(
  "/:id/approve",
  asyncHandler(async (req, res) => {
    const body = approvalDecisionSchema.parse({ decision: "APPROVE", note: req.body?.note });
    const attempt = await prisma.recoveryAttempt.findFirst({
      where: { id: req.params.id, merchantId: req.merchantId },
    });
    if (!attempt) {
      res.status(404).json({ error: "Recovery attempt not found" });
      return;
    }
    if (attempt.status !== "AWAITING_APPROVAL") {
      res.status(409).json({ error: `Attempt is in status ${attempt.status}, not awaiting approval.` });
      return;
    }

    await prisma.recoveryAttempt.update({
      where: { id: attempt.id },
      data: { status: "APPROVED", approvalStatus: "APPROVED", approvalNote: body.note },
    });
    await writeAudit({
      merchantId: attempt.merchantId,
      paymentId: attempt.paymentId,
      attemptId: attempt.id,
      eventType: "APPROVAL_DECISION",
      approvalStatus: "APPROVED",
      action: attempt.action,
    });

    // A simulated attempt has no real customer behind it, so a real Razorpay call would either
    // fail (test credentials aside) or succeed against an order/link nobody will ever pay — either
    // way it could never reach a terminal outcome on its own. Keep resolving it synthetically.
    const result = await executeAttempt(attempt.id, attempt.isSimulated ? { simulate: true } : {});
    res.json({ attempt: result });
  }),
);

recoveryRouter.post(
  "/:id/reject",
  asyncHandler(async (req, res) => {
    const body = approvalDecisionSchema.parse({ decision: "REJECT", note: req.body?.note });
    const attempt = await prisma.recoveryAttempt.findFirst({
      where: { id: req.params.id, merchantId: req.merchantId },
    });
    if (!attempt) {
      res.status(404).json({ error: "Recovery attempt not found" });
      return;
    }
    if (attempt.status !== "AWAITING_APPROVAL") {
      res.status(409).json({ error: `Attempt is in status ${attempt.status}, not awaiting approval.` });
      return;
    }

    const updated = await prisma.recoveryAttempt.update({
      where: { id: attempt.id },
      data: { status: "REJECTED", approvalStatus: "REJECTED", approvalNote: body.note, outcome: "REJECTED_BY_MERCHANT" },
    });
    await writeAudit({
      merchantId: attempt.merchantId,
      paymentId: attempt.paymentId,
      attemptId: attempt.id,
      eventType: "APPROVAL_DECISION",
      approvalStatus: "REJECTED",
      action: attempt.action,
      outcome: "REJECTED_BY_MERCHANT",
    });

    res.json({ attempt: updated });
  }),
);

/** Manual "execute now" for a due-but-not-yet-run attempt — useful for the live demo instead of
 *  waiting on the 1-minute scheduler tick. Goes through the exact same executionService path. */
recoveryRouter.post(
  "/:id/execute",
  asyncHandler(async (req, res) => {
    const attempt = await prisma.recoveryAttempt.findFirst({
      where: { id: req.params.id, merchantId: req.merchantId },
    });
    if (!attempt) {
      res.status(404).json({ error: "Recovery attempt not found" });
      return;
    }
    const result = await executeAttempt(attempt.id, attempt.isSimulated ? { simulate: true } : {});
    res.json({ attempt: result });
  }),
);
