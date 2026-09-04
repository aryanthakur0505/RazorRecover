import { Router } from "express";
import { prisma } from "../db";
import { requireSession } from "../middleware/session";
import { asyncHandler } from "../middleware/errorHandler";
import { doNotContactUpdateSchema, customerNoteSchema } from "../schemas/api";
import { writeAudit } from "../services/auditService";
import { parsePagination } from "../utils/listQuery";

export const customersRouter = Router();
customersRouter.use(requireSession);

/**
 * Two modes on one route, since they're both just "list customers, filtered":
 *  - ?q=... — the global command palette (Ctrl/Cmd+K) search, capped at 8, requires 2+ characters
 *    so a single keystroke doesn't fire a query for every customer.
 *  - ?doNotContact=true — the full, paginated exclude list (Policies & Audit), so a merchant can
 *    actually see and manage everyone they've excluded instead of only stumbling onto one while
 *    already looking at their specific profile or attempt.
 */
customersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    if (req.query.doNotContact === "true") {
      const { page, pageSize, skip, take } = parsePagination(req);
      const where = { merchantId: req.merchantId, doNotContact: true as const };
      const [customers, total] = await Promise.all([
        prisma.customer.findMany({
          where,
          select: { id: true, name: true, email: true, doNotContact: true, doNotContactReason: true, doNotContactAt: true },
          orderBy: { doNotContactAt: "desc" },
          skip,
          take,
        }),
        prisma.customer.count({ where }),
      ]);
      res.json({ customers, total, page, pageSize });
      return;
    }

    const q = (req.query.q as string | undefined)?.trim();
    if (!q || q.length < 2) {
      res.json({ customers: [] });
      return;
    }
    const customers = await prisma.customer.findMany({
      where: {
        merchantId: req.merchantId,
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
        ],
      },
      select: { id: true, name: true, email: true, doNotContact: true },
      // `id` as a tiebreaker: Postgres doesn't guarantee stable relative order among rows tied on
      // name alone, so without one, two customers who happen to share a name could swap places
      // between identical repeated queries — confusing given results update on every keystroke.
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: 8,
    });
    res.json({ customers });
  }),
);

/**
 * Full customer profile — everything currently scattered across individual recovery-attempt
 * drawers (payment history, recovery history, do-not-contact status), in one place. Unlike
 * customerStats.ts (which feeds the AI/scoring and is deliberately data-minimized), this is
 * merchant-facing: a human reviewing their own customer is allowed to see the full picture.
 */
customersRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id, merchantId: req.merchantId },
    });
    if (!customer) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }

    const [payments, notes] = await Promise.all([
      prisma.payment.findMany({
        where: { customerId: customer.id, merchantId: req.merchantId },
        include: { attempts: { orderBy: { createdAt: "asc" } } },
        orderBy: { createdAt: "desc" },
      }),
      prisma.customerNote.findMany({
        where: { customerId: customer.id, merchantId: req.merchantId },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    const successfulPayments = payments.filter((p) => p.status === "CAPTURED");
    const failedPayments = payments.filter((p) => p.status === "FAILED");
    const allAttempts = payments.flatMap((p) => p.attempts);
    const resolvedAttempts = allAttempts.filter((a) => a.status === "SUCCEEDED" || a.status === "FAILED");
    const successfulRecoveries = allAttempts.filter((a) => a.status === "SUCCEEDED");

    const stats = {
      totalPayments: payments.length,
      successfulPayments: successfulPayments.length,
      failedPayments: failedPayments.length,
      lifetimeValue: successfulPayments.reduce((sum, p) => sum + p.amount, 0),
      totalRecoveryAttempts: allAttempts.length,
      successfulRecoveries: successfulRecoveries.length,
      revenueRecovered: allAttempts.reduce((sum, a) => sum + (a.revenueRecovered ?? 0), 0),
      recoveryRate: resolvedAttempts.length > 0 ? successfulRecoveries.length / resolvedAttempts.length : null,
      customerSince: payments.length > 0 ? payments[payments.length - 1].createdAt : customer.createdAt,
    };

    res.json({ customer, stats, payments, notes });
  }),
);

/** Free-text merchant notes on a customer — see the CustomerNote model doc for why this is
 *  append-only (no PATCH/DELETE route exposed anywhere). */
customersRouter.post(
  "/:id/notes",
  asyncHandler(async (req, res) => {
    const body = customerNoteSchema.parse(req.body);
    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id, merchantId: req.merchantId },
    });
    if (!customer) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }

    const note = await prisma.customerNote.create({
      data: { merchantId: req.merchantId!, customerId: customer.id, body: body.body },
    });
    await writeAudit({
      merchantId: req.merchantId!,
      customerId: customer.id,
      eventType: "CUSTOMER_NOTE_ADDED",
      // Reusing the generic freeform-text field (same pattern as do-not-contact's reason) so the
      // audit trail actually shows what was written, not just that something was — otherwise this
      // event is the one entry in the whole log whose own content is invisible from the log itself.
      failureReason: body.body,
    });

    res.status(201).json({ note });
  }),
);

/**
 * Merchant-controlled exclude list. Turning this ON immediately stops any of this customer's
 * attempts still sitting in PENDING/AWAITING_APPROVAL from going any further — a merchant flipping
 * this switch means "stop contacting them now", not "stop contacting them starting with their next
 * failed payment". Future attempts are blocked by the same guardrail (policyEngine's
 * do_not_contact rule) regardless of this cleanup, so this is a UX nicety, not the enforcement
 * point itself.
 */
customersRouter.patch(
  "/:id/do-not-contact",
  asyncHandler(async (req, res) => {
    const body = doNotContactUpdateSchema.parse(req.body);
    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id, merchantId: req.merchantId },
    });
    if (!customer) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }

    const updated = await prisma.customer.update({
      where: { id: customer.id },
      data: {
        doNotContact: body.doNotContact,
        doNotContactReason: body.doNotContact ? (body.reason ?? null) : null,
        doNotContactAt: body.doNotContact ? new Date() : null,
      },
    });

    await writeAudit({
      merchantId: req.merchantId!,
      customerId: customer.id,
      eventType: body.doNotContact ? "DO_NOT_CONTACT_ENABLED" : "DO_NOT_CONTACT_DISABLED",
      failureReason: body.reason,
    });

    let stoppedCount = 0;
    if (body.doNotContact) {
      // Stop anything still in flight for this customer that would otherwise go on to contact
      // them — mirrors exactly what the policy guardrail would do to a *new* attempt, just applied
      // retroactively to attempts already queued.
      const pending = await prisma.recoveryAttempt.findMany({
        where: {
          merchantId: req.merchantId,
          status: { in: ["PENDING", "AWAITING_APPROVAL"] },
          action: { in: ["RETRY", "PAYMENT_LINK"] },
          payment: { customerId: customer.id },
        },
      });
      for (const attempt of pending) {
        await prisma.recoveryAttempt.update({
          where: { id: attempt.id },
          data: { status: "STOPPED", outcome: "DO_NOT_CONTACT" },
        });
        await writeAudit({
          merchantId: req.merchantId!,
          paymentId: attempt.paymentId,
          customerId: customer.id,
          attemptId: attempt.id,
          eventType: "POLICY_BLOCKED",
          action: attempt.action,
          outcome: "DO_NOT_CONTACT",
        });
      }
      stoppedCount = pending.length;
    }

    res.json({ customer: updated, stoppedCount });
  }),
);
