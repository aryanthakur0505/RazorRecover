import { Router } from "express";
import { prisma } from "../db";
import { requireSession } from "../middleware/session";
import { asyncHandler } from "../middleware/errorHandler";
import { parsePagination } from "../utils/listQuery";
import { writeAudit } from "../services/auditService";
import { resolveOfferIfDue, simulateDuePastInstallments } from "../services/emiService";
import { installmentPlanStatusQuerySchema } from "../schemas/api";

export const installmentPlansRouter = Router();
installmentPlansRouter.use(requireSession);

/** List plans — the "who opted for EMI" page. Filterable by status so a merchant can jump
 *  straight to ACTIVE (needs watching) or DEFAULTED (needs a decision) without scrolling past
 *  everything else. */
installmentPlansRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { page, pageSize, skip, take } = parsePagination(req);
    const statusFilter = installmentPlanStatusQuerySchema.parse(req.query.status);
    const where = {
      merchantId: req.merchantId!,
      ...(statusFilter ? { status: statusFilter } : {}),
    };
    const [plans, total] = await Promise.all([
      prisma.installmentPlan.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true, email: true } },
          installments: { orderBy: { installmentNumber: "asc" } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.installmentPlan.count({ where }),
    ]);

    const rows = plans.map((p) => ({
      id: p.id,
      customer: p.customer,
      paymentId: p.paymentId,
      principalAmount: p.principalAmount,
      tenureMonths: p.tenureMonths,
      annualInterestRateBps: p.annualInterestRateBps,
      totalInterest: p.totalInterest,
      totalPayable: p.totalPayable,
      monthlyAmount: p.monthlyAmount,
      status: p.status,
      startDate: p.startDate,
      offerExpiresAt: p.offerExpiresAt,
      paidCount: p.installments.filter((i) => i.status === "PAID").length,
      missedCount: p.installments.filter((i) => i.status === "MISSED").length,
      pendingCount: p.installments.filter((i) => i.status === "PENDING").length,
    }));

    res.json({ plans: rows, total, page, pageSize });
  }),
);

/** Full detail for one plan — the month-by-month grid. */
installmentPlansRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const plan = await prisma.installmentPlan.findFirst({
      where: { id: req.params.id, merchantId: req.merchantId! },
      include: {
        customer: { select: { id: true, name: true, email: true } },
        payment: { select: { id: true, amount: true, failureCategory: true, failedAt: true } },
        installments: { orderBy: { installmentNumber: "asc" } },
      },
    });
    if (!plan) {
      res.status(404).json({ error: "Installment plan not found" });
      return;
    }
    res.json({ plan });
  }),
);

/**
 * Manual override for one installment — lets a merchant record what actually happened (a real
 * payment came in, or a due date passed with nothing) instead of only trusting the simulated
 * model. Re-checks plan completion/default the same way the simulated path does, so a manually
 * recorded payment can complete a plan or a manually recorded miss can trigger a default exactly
 * like an automatic one would.
 */
installmentPlansRouter.post(
  "/:id/installments/:installmentNumber/mark",
  asyncHandler(async (req, res) => {
    const status = req.body?.status === "PAID" || req.body?.status === "MISSED" ? req.body.status : undefined;
    if (!status) {
      res.status(400).json({ error: "status must be PAID or MISSED" });
      return;
    }
    const plan = await prisma.installmentPlan.findFirst({
      where: { id: req.params.id, merchantId: req.merchantId! },
      include: { installments: true },
    });
    if (!plan) {
      res.status(404).json({ error: "Installment plan not found" });
      return;
    }
    if (plan.status !== "ACTIVE") {
      res.status(409).json({ error: `Plan is ${plan.status}, not accepting further updates.` });
      return;
    }
    const installmentNumber = Number(req.params.installmentNumber);
    const installment = plan.installments.find((i) => i.installmentNumber === installmentNumber);
    if (!installment) {
      res.status(404).json({ error: "Installment not found on this plan" });
      return;
    }
    if (installment.status !== "PENDING") {
      res.status(409).json({ error: `Installment is already ${installment.status}.` });
      return;
    }

    await prisma.installment.update({
      where: { id: installment.id },
      data: { status, paidAt: status === "PAID" ? new Date() : null },
    });
    const isPromise = plan.tenureMonths === 1;
    await writeAudit({
      merchantId: plan.merchantId,
      paymentId: plan.paymentId,
      customerId: plan.customerId,
      attemptId: plan.attemptId,
      eventType: isPromise
        ? status === "PAID" ? "PROMISE_KEPT" : "PROMISE_BROKEN"
        : status === "PAID" ? "INSTALLMENT_PAID" : "INSTALLMENT_MISSED",
      amount: installment.amount,
      outcome: isPromise ? undefined : `INSTALLMENT_${installment.installmentNumber}_OF_${plan.tenureMonths}_MANUAL`,
    });

    // Reuse the exact same consecutive-miss / completion logic the simulated path uses, run
    // forward from "now" so a manual update can trigger a default or completion the same way an
    // automatic one would — no separate rulebook for manual vs simulated resolution.
    const updated = await simulateDuePastInstallments(plan.id, new Date());
    res.json({ plan: updated });
  }),
);

/** Merchant calls this off manually — either withdrawing an offer before the customer responds
 *  (OFFERED), or before default/completion on an accepted plan (ACTIVE), e.g. the customer paid
 *  the remaining balance out-of-band. Doesn't touch the underlying attempt/payment; a merchant
 *  who cancels is expected to resolve the payment through whatever channel actually happened. */
installmentPlansRouter.post(
  "/:id/cancel",
  asyncHandler(async (req, res) => {
    const plan = await prisma.installmentPlan.findFirst({ where: { id: req.params.id, merchantId: req.merchantId! } });
    if (!plan) {
      res.status(404).json({ error: "Installment plan not found" });
      return;
    }
    if (plan.status !== "ACTIVE" && plan.status !== "OFFERED") {
      res.status(409).json({ error: `Plan is ${plan.status}, cannot cancel.` });
      return;
    }
    const updated = await prisma.installmentPlan.update({ where: { id: plan.id }, data: { status: "CANCELLED" } });
    await writeAudit({
      merchantId: plan.merchantId,
      paymentId: plan.paymentId,
      customerId: plan.customerId,
      attemptId: plan.attemptId,
      eventType: "EMI_PLAN_CANCELLED",
    });
    res.json({ plan: updated });
  }),
);

/**
 * Demo/manual convenience: forces an OFFERED plan to resolve right now instead of waiting for
 * its real offerExpiresAt — treats "now" as if the window had already closed, so the same
 * response-probability + tenure-weighting model in resolveOfferIfDue still decides the outcome,
 * just without the wait. Also how a merchant would record a customer who called in and responded
 * verbally rather than clicking the offer link.
 */
installmentPlansRouter.post(
  "/:id/offer/resolve-now",
  asyncHandler(async (req, res) => {
    const plan = await prisma.installmentPlan.findFirst({ where: { id: req.params.id, merchantId: req.merchantId! } });
    if (!plan) {
      res.status(404).json({ error: "Installment plan not found" });
      return;
    }
    if (plan.status !== "OFFERED") {
      res.status(409).json({ error: `Plan is ${plan.status}, not an open offer.` });
      return;
    }
    const asOf = plan.offerExpiresAt && plan.offerExpiresAt > new Date() ? plan.offerExpiresAt : new Date();
    const updated = await resolveOfferIfDue(plan.id, asOf);
    res.json({ plan: updated });
  }),
);
