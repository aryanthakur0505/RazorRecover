import { Router, Request } from "express";
import { randomUUID } from "crypto";
import { RecoveryAttempt } from "@prisma/client";
import { prisma } from "../db";
import { requireSession } from "../middleware/session";
import { asyncHandler } from "../middleware/errorHandler";
import {
  approvalDecisionSchema,
  escalationResolutionSchema,
  bulkAttemptIdsSchema,
  bulkActionRequestSchema,
  retryOverrideSchema,
} from "../schemas/api";
import { executeAttempt, resolveEscalation, buildIdempotencyKey } from "../services/executionService";
import { writeAudit } from "../services/auditService";
import { parsePagination, parseDateRange, parseAmountSearch, encodeCursor, decodeCursor, cursorWhere } from "../utils/listQuery";
import { runWithConcurrency } from "../utils/concurrency";
import { toCsv } from "../utils/csv";
import { nextEligibleCommunicationAt } from "../services/customerStats";

export const recoveryRouter = Router();
recoveryRouter.use(requireSession);

/** Same filter semantics used by the opportunities list and the "select all matching this filter"
 *  bulk-job endpoint — kept in one place so the two can never disagree on what a given filter
 *  actually matches. `forcedStatus`, when given, overrides whatever status the query string asked
 *  for (bulk actions only ever apply to AWAITING_APPROVAL, regardless of which tab the merchant
 *  happened to be viewing when they clicked "select all"). */
function buildOpportunityWhere(req: Request, merchantId: string, forcedStatus?: string) {
  const status = forcedStatus ?? (req.query.status as string | undefined);
  const q = (req.query.q as string | undefined)?.trim();
  const dateFilter = parseDateRange(req, "createdAt");
  const searchAmount = q ? parseAmountSearch(q) : undefined;

  return {
    merchantId,
    ...(status ? { status: status as any } : {}),
    ...dateFilter,
    ...(q
      ? {
          OR: [
            { id: q },
            { payment: { id: q } },
            { payment: { customer: { name: { contains: q, mode: "insensitive" as const } } } },
            { payment: { customer: { email: { contains: q, mode: "insensitive" as const } } } },
            ...(searchAmount !== undefined ? [{ payment: { amount: searchAmount } }] : []),
          ],
        }
      : {}),
  };
}

/** Recovery opportunities queue — RecoveryAttempts joined with their payment/customer, scoped
 *  strictly to the session's merchant. Never trusts a merchantId from the client. Supports a
 *  free-text search (customer name/email, payment/attempt id, amount), a date range, and cursor
 *  pagination — old records stay reachable no matter how much new traffic has come in since,
 *  instead of just falling off the end of a fixed-size list. Cursor-based (not skip/take): this
 *  list is written to constantly (simulations, the scheduler, live webhooks), and offset paging
 *  breaks under concurrent inserts — see listQuery.ts's cursorWhere doc for why. */
recoveryRouter.get(
  "/opportunities",
  asyncHandler(async (req, res) => {
    const { pageSize } = parsePagination(req);
    const filterWhere = buildOpportunityWhere(req, req.merchantId!);
    const cursor = decodeCursor(req.query.cursor as string | undefined);
    const where = { AND: [filterWhere, cursorWhere("createdAt", cursor)] };

    const [attempts, total] = await Promise.all([
      prisma.recoveryAttempt.findMany({
        where,
        include: { payment: { include: { customer: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: pageSize,
      }),
      // Total reflects the whole filtered set, not just what's been paged through — deliberately
      // ignores the cursor.
      prisma.recoveryAttempt.count({ where: filterWhere }),
    ]);

    const last = attempts[attempts.length - 1];
    const nextCursor = attempts.length === pageSize && last ? encodeCursor(last.createdAt, last.id) : null;

    res.json({ attempts, total, pageSize, nextCursor });
  }),
);

// Safety ceiling on one export, independent of how many rows actually match the filter — protects
// a single-instance deployment from one request loading an unbounded result set into memory. Well
// above any realistic dataset size for this project; not surfaced to the merchant because hitting
// it would mean the export itself has become impractical to open in a spreadsheet anyway.
const EXPORT_MAX_ROWS = 10_000;

/** CSV export of whatever the opportunities list currently shows — same filter (status/q/from/to)
 *  as GET /opportunities, but unpaginated (up to EXPORT_MAX_ROWS) since the point is to get
 *  everything matching the view into a spreadsheet, not just the currently-loaded page. */
recoveryRouter.get(
  "/opportunities/export",
  asyncHandler(async (req, res) => {
    const where = buildOpportunityWhere(req, req.merchantId!);
    const attempts = await prisma.recoveryAttempt.findMany({
      where,
      include: { payment: { include: { customer: true } } },
      orderBy: { createdAt: "desc" },
      take: EXPORT_MAX_ROWS,
    });

    const header = [
      "Customer Name",
      "Customer Email",
      "Amount (INR)",
      "Failure Category",
      "Recovery Score",
      "Action",
      "Status",
      "Outcome",
      "Used AI",
      "Revenue Recovered (INR)",
      "Recovery Cost (INR)",
      "Net Recovered (INR)",
      "Created At",
    ];
    const rows = attempts.map((a) => [
      a.payment.customer.name,
      a.payment.customer.email,
      (a.payment.amount / 100).toFixed(2),
      a.payment.failureCategory,
      a.payment.recoveryScore ?? "",
      a.action,
      a.status,
      a.outcome ?? "",
      a.usedAI ? "Yes" : "No",
      a.revenueRecovered !== null ? (a.revenueRecovered / 100).toFixed(2) : "",
      a.recoveryCost !== null ? (a.recoveryCost / 100).toFixed(2) : "",
      a.netRecovered !== null ? (a.netRecovered / 100).toFixed(2) : "",
      a.createdAt.toISOString(),
    ]);

    const csv = toCsv([header, ...rows]);
    const filename = `recovery-operations-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    // BOM so Excel opens the ₹-free (already-plain-number) file as UTF-8 rather than guessing a
    // legacy codepage — matters once customer names include non-ASCII characters.
    res.send("﻿" + csv);
  }),
);

/**
 * "Cooling Down" / "Exhausted" — payments stopped for repeated-contact reasons, classified by
 * their MOST RECENT attempt (not attempt-level filtering like /opportunities, since the same
 * payment can have been stopped-then-retried-then-stopped-again many times; only where it stands
 * right now matters here):
 *   - cooling_down: latest attempt STOPPED with outcome COMMUNICATION_LIMIT_REACHED — the
 *     scheduler (see scheduler.ts scanCoolingDownPayments) will automatically retry these once
 *     the window resets, no merchant click needed.
 *   - exhausted: latest attempt STOPPED with riskFlags containing "max_retries_reached" — the
 *     policy's own attempt ceiling was hit, so nothing will retry this automatically anymore;
 *     needs a human decision (escalate differently, override, or Do-Not-Contact).
 * Fetch-then-classify-in-JS rather than a single WHERE clause, since "the latest attempt matches
 * X" isn't expressible as a plain column filter — acceptable at this app's scale, same pattern
 * already used for the outcome funnel.
 *
 * Registered before the "/:id" catch-all below — Express matches routes in registration order, so
 * this has to come first or "/re-engagement" gets swallowed as if it were an attempt id (exactly
 * the bug this comment is here to stop someone from reintroducing).
 */
recoveryRouter.get(
  "/re-engagement",
  asyncHandler(async (req, res) => {
    const bucket = req.query.bucket === "exhausted" ? "exhausted" : "cooling_down";
    const { page, pageSize } = parsePagination(req);
    const merchantId = req.merchantId!;

    const [payments, policy] = await Promise.all([
      prisma.payment.findMany({
        where: { merchantId, status: "FAILED" },
        include: {
          customer: { select: { id: true, name: true, email: true } },
          attempts: { orderBy: { createdAt: "desc" }, take: 1 },
        },
        orderBy: { updatedAt: "desc" },
      }),
      prisma.recoveryPolicy.findUniqueOrThrow({ where: { merchantId } }),
    ]);

    const matches = payments.filter((p) => {
      const latest = p.attempts[0];
      if (!latest || latest.status !== "STOPPED") return false;
      if (bucket === "cooling_down") return latest.outcome === "COMMUNICATION_LIMIT_REACHED";
      const flags = Array.isArray(latest.riskFlags) ? (latest.riskFlags as unknown[]) : [];
      return flags.includes("max_retries_reached");
    });

    const total = matches.length;
    const pageRows = matches.slice((page - 1) * pageSize, page * pageSize);

    const rows = await Promise.all(
      pageRows.map(async (p) => {
        const latest = p.attempts[0];
        const nextEligibleAt =
          bucket === "cooling_down"
            ? await nextEligibleCommunicationAt(p.customer.id, merchantId, policy.communicationPeriodHours)
            : null;
        return {
          paymentId: p.id,
          customer: p.customer,
          amount: p.amount,
          failureCategory: p.failureCategory,
          attemptNumber: latest.attemptNumber,
          lastAttemptAt: latest.createdAt,
          nextEligibleAt,
        };
      }),
    );

    res.json({ rows, total, page, pageSize });
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

/** Shared core of both the single-attempt and bulk approve routes — kept in one place so the two
 *  can never drift on what "approve" actually means. Returns a discriminated result rather than
 *  throwing, so a bulk caller can carry on past one failed id instead of aborting the whole batch. */
async function approveOne(
  attemptId: string,
  merchantId: string,
  note?: string,
  promise?: { dueDate: Date; amount?: number },
): Promise<{ id: string; ok: true; attempt: RecoveryAttempt } | { id: string; ok: false; error: string }> {
  const attempt = await prisma.recoveryAttempt.findFirst({ where: { id: attemptId, merchantId } });
  if (!attempt) return { id: attemptId, ok: false, error: "Recovery attempt not found" };
  if (attempt.status !== "AWAITING_APPROVAL") {
    return { id: attemptId, ok: false, error: `Attempt is in status ${attempt.status}, not awaiting approval.` };
  }
  // Approving an EMI_PLAN attempt only authorizes SENDING the offer — the customer picks which of
  // the 6/12/24-month options they want (see emiService.resolveOfferIfDue), not the merchant.
  // A logged promise only makes sense on an ESCALATE follow-up — it's how the merchant records
  // what the customer committed to instead of resolving it directly via POST /:id/resolve.
  if (promise && attempt.action !== "ESCALATE") {
    return { id: attemptId, ok: false, error: "A promise can only be logged on an ESCALATE attempt." };
  }

  await prisma.recoveryAttempt.update({
    where: { id: attempt.id },
    data: {
      status: "APPROVED",
      approvalStatus: "APPROVED",
      approvalNote: note,
      ...(promise ? { promisedDueDate: promise.dueDate, promisedAmount: promise.amount } : {}),
    },
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
  const result = await executeAttempt(attempt.id, {
    ...(attempt.isSimulated ? { simulate: true } : {}),
    ...(attempt.retryOverride ? { retryOverride: true } : {}),
  });
  return { id: attemptId, ok: true, attempt: result };
}

/** Shared core of both the single-attempt and bulk reject routes — see approveOne. */
async function rejectOne(
  attemptId: string,
  merchantId: string,
  note?: string,
): Promise<{ id: string; ok: true; attempt: RecoveryAttempt } | { id: string; ok: false; error: string }> {
  const attempt = await prisma.recoveryAttempt.findFirst({ where: { id: attemptId, merchantId } });
  if (!attempt) return { id: attemptId, ok: false, error: "Recovery attempt not found" };
  if (attempt.status !== "AWAITING_APPROVAL") {
    return { id: attemptId, ok: false, error: `Attempt is in status ${attempt.status}, not awaiting approval.` };
  }

  const updated = await prisma.recoveryAttempt.update({
    where: { id: attempt.id },
    data: { status: "REJECTED", approvalStatus: "REJECTED", approvalNote: note, outcome: "REJECTED_BY_MERCHANT" },
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

  return { id: attemptId, ok: true, attempt: updated };
}

// Bulk actions run with bounded concurrency rather than one-at-a-time (slow for a big queue) or
// all-at-once (would hammer Razorpay/the DB with as many requests as the merchant selected).
const BULK_ACTION_CONCURRENCY = 5;

recoveryRouter.post(
  "/:id/approve",
  asyncHandler(async (req, res) => {
    const body = approvalDecisionSchema.parse({
      decision: "APPROVE",
      note: req.body?.note,
      promise: req.body?.promise,
    });
    const result = await approveOne(req.params.id, req.merchantId!, body.note, body.promise);
    if (!result.ok) {
      res.status(result.error === "Recovery attempt not found" ? 404 : 409).json({ error: result.error });
      return;
    }
    res.json({ attempt: result.attempt });
  }),
);

recoveryRouter.post(
  "/:id/reject",
  asyncHandler(async (req, res) => {
    const body = approvalDecisionSchema.parse({ decision: "REJECT", note: req.body?.note });
    const result = await rejectOne(req.params.id, req.merchantId!, body.note);
    if (!result.ok) {
      res.status(result.error === "Recovery attempt not found" ? 404 : 409).json({ error: result.error });
      return;
    }
    res.json({ attempt: result.attempt });
  }),
);

/** Bulk approve — lets a merchant clear a backlog of awaiting-approval attempts in one action
 *  instead of clicking through them one at a time. Each id is still independently validated and
 *  routed through the exact same approve path (guardrails re-checked, Razorpay called per attempt)
 *  — this is a batch of the same operation, not a different, less-safe one. */
recoveryRouter.post(
  "/bulk-approve",
  asyncHandler(async (req, res) => {
    const body = bulkAttemptIdsSchema.parse(req.body);
    const results = await runWithConcurrency(
      body.ids.map((id) => () => approveOne(id, req.merchantId!, body.note)),
      BULK_ACTION_CONCURRENCY,
    );
    const succeeded = results.filter((r) => r.ok).length;
    res.json({ results, succeeded, failed: results.length - succeeded });
  }),
);

/** Bulk reject — see bulk-approve. */
recoveryRouter.post(
  "/bulk-reject",
  asyncHandler(async (req, res) => {
    const body = bulkAttemptIdsSchema.parse(req.body);
    const results = await runWithConcurrency(
      body.ids.map((id) => () => rejectOne(id, req.merchantId!, body.note)),
      BULK_ACTION_CONCURRENCY,
    );
    const succeeded = results.filter((r) => r.ok).length;
    res.json({ results, succeeded, failed: results.length - succeeded });
  }),
);

// --- Filter-scoped bulk jobs ---------------------------------------------------------------
//
// bulk-approve/bulk-reject above take an explicit id list, capped at 200, and run synchronously —
// fine for "I checked a handful of rows on this page", but it doesn't scale: a merchant with
// thousands sitting in the queue can't select more than what's actually loaded in the browser, and
// a synchronous request processing thousands of Razorpay calls would just time out. This is the
// "select all N matching this filter" path instead: it never takes ids at all, resolves the match
// itself (same filter the opportunities list uses), and runs as a background job the frontend
// polls — so a merchant with 20 stuck items and one with 20,000 use the exact same button.

interface BulkJob {
  status: "RUNNING" | "COMPLETED" | "FAILED";
  action: "approve" | "reject";
  processed: number;
  total: number;
  succeeded: number;
  failed: number;
  errors: { id: string; error: string }[]; // capped sample, not every failure — see below
  truncated: boolean;
  error?: string;
}

// In-memory, same trade-off as the simulation job tracker (routes/simulation.ts) — fine for a
// single-instance deployment; a multi-instance one would need this in the database or a shared cache.
const bulkJobs = new Map<string, BulkJob>();

// Hard safety ceiling on one job, independent of how big "matching this filter" turns out to be —
// protects a single-instance deployment from one request resolving an unbounded id list into
// memory. `truncated` is reported back rather than silently dropping the rest — running the same
// action again picks up wherever it left off, since already-actioned attempts no longer match the
// AWAITING_APPROVAL filter.
const BULK_JOB_MAX_ITEMS = 5000;
const BULK_JOB_ERROR_SAMPLE = 20;

async function runBulkJob(
  jobId: string,
  merchantId: string,
  action: "approve" | "reject",
  where: ReturnType<typeof buildOpportunityWhere>,
  note: string | undefined,
) {
  try {
    const matches = await prisma.recoveryAttempt.findMany({
      where,
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: BULK_JOB_MAX_ITEMS + 1,
    });
    const truncated = matches.length > BULK_JOB_MAX_ITEMS;
    const ids = matches.slice(0, BULK_JOB_MAX_ITEMS).map((m) => m.id);
    const total = ids.length;

    bulkJobs.set(jobId, { status: "RUNNING", action, processed: 0, total, succeeded: 0, failed: 0, errors: [], truncated });
    if (total === 0) {
      bulkJobs.set(jobId, { status: "COMPLETED", action, processed: 0, total: 0, succeeded: 0, failed: 0, errors: [], truncated });
      return;
    }

    const fn = action === "approve" ? approveOne : rejectOne;
    let processed = 0;
    let succeeded = 0;
    const errors: { id: string; error: string }[] = [];

    await runWithConcurrency(
      ids.map((id) => async () => {
        const result = await fn(id, merchantId, note);
        processed++;
        if (result.ok) succeeded++;
        else if (errors.length < BULK_JOB_ERROR_SAMPLE) errors.push({ id: result.id, error: result.error });
        bulkJobs.set(jobId, {
          status: "RUNNING",
          action,
          processed,
          total,
          succeeded,
          failed: processed - succeeded,
          errors,
          truncated,
        });
      }),
      BULK_ACTION_CONCURRENCY,
    );

    bulkJobs.set(jobId, {
      status: "COMPLETED",
      action,
      processed: total,
      total,
      succeeded,
      failed: total - succeeded,
      errors,
      truncated,
    });
  } catch (err) {
    console.error("[recovery] bulk job failed:", err);
    const existing = bulkJobs.get(jobId);
    bulkJobs.set(jobId, {
      status: "FAILED",
      action,
      processed: existing?.processed ?? 0,
      total: existing?.total ?? 0,
      succeeded: existing?.succeeded ?? 0,
      failed: existing?.failed ?? 0,
      errors: existing?.errors ?? [],
      truncated: existing?.truncated ?? false,
      error: err instanceof Error ? err.message : "Bulk job failed",
    });
  }
}

/** Kicks off a filter-scoped bulk approve/reject job and returns immediately — the frontend polls
 *  GET /bulk-jobs/:jobId for progress, same shape as the simulation job endpoint. The filter is
 *  read from the query string with the exact same parsing as GET /opportunities (status/q/from/to),
 *  so "select all matching this filter" always matches what the merchant was actually looking at. */
recoveryRouter.post(
  "/bulk-jobs",
  asyncHandler(async (req, res) => {
    const body = bulkActionRequestSchema.parse(req.body);
    const where = buildOpportunityWhere(req, req.merchantId!, "AWAITING_APPROVAL");
    const jobId = randomUUID();

    bulkJobs.set(jobId, { status: "RUNNING", action: body.action, processed: 0, total: 0, succeeded: 0, failed: 0, errors: [], truncated: false });
    res.json({ jobId });

    // Fire-and-forget: id resolution + processing both happen in the background so the response
    // time never depends on how many attempts actually match.
    runBulkJob(jobId, req.merchantId!, body.action, where, body.note);
  }),
);

recoveryRouter.get(
  "/bulk-jobs/:jobId",
  asyncHandler(async (req, res) => {
    const job = bulkJobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Bulk job not found" });
      return;
    }
    res.json(job);
  }),
);

/** Records what happened after a merchant manually followed up on an escalated (suspicious /
 *  human-reviewed) payment — the one action with no Razorpay call and therefore no webhook that
 *  could ever resolve it on its own. Only valid on a live (non-simulated), EXECUTED escalation;
 *  simulated ones already resolve automatically. */
recoveryRouter.post(
  "/:id/resolve",
  asyncHandler(async (req, res) => {
    const body = escalationResolutionSchema.parse(req.body);
    const attempt = await prisma.recoveryAttempt.findFirst({
      where: { id: req.params.id, merchantId: req.merchantId },
    });
    if (!attempt) {
      res.status(404).json({ error: "Recovery attempt not found" });
      return;
    }
    if (attempt.isSimulated) {
      res.status(409).json({ error: "Simulated attempts resolve automatically and can't be manually resolved." });
      return;
    }
    try {
      const result = await resolveEscalation(attempt.id, body.outcome === "RECOVERED", body.note);
      res.json({ attempt: result });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : "Could not resolve this attempt." });
    }
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
    const result = await executeAttempt(attempt.id, {
      ...(attempt.isSimulated ? { simulate: true } : {}),
      ...(attempt.retryOverride ? { retryOverride: true } : {}),
    });
    res.json({ attempt: result });
  }),
);

// A stop for one of these reasons is a *timing/volume* guardrail, or the deterministic engine's
// own low-score decision — the kind of thing a merchant might reasonably know better than the
// policy default for one specific case. PAYMENT_ALREADY_RESOLVED, SUSPICIOUS_PAYMENT, and
// DO_NOT_CONTACT are deliberately absent — see the policyEngine bypassSoftGuardrails doc for why
// those three never get a one-click override.
const OVERRIDABLE_STOP_REASONS = new Set([
  "MAX_RETRIES_REACHED",
  "COMMUNICATION_LIMIT_REACHED",
  "QUIET_HOURS",
  "RETRY_TOO_SOON",
  "STOPPED_BY_POLICY",
]);

/** "Retry Anyway" — a merchant explicitly overriding a previously-STOPPED attempt. Re-runs it
 *  through the exact same guardrail pipeline, just with the soft (timing/volume) checks bypassed —
 *  see executionService's retryOverride option and policyEngine's bypassSoftGuardrails for what
 *  that actually means. Always requires a fresh approval before anything reaches Razorpay,
 *  regardless of amount. */
recoveryRouter.post(
  "/:id/retry-override",
  asyncHandler(async (req, res) => {
    const body = retryOverrideSchema.parse(req.body ?? {});
    const attempt = await prisma.recoveryAttempt.findFirst({
      where: { id: req.params.id, merchantId: req.merchantId },
    });
    if (!attempt) {
      res.status(404).json({ error: "Recovery attempt not found" });
      return;
    }
    if (attempt.status !== "STOPPED") {
      res.status(409).json({ error: `Attempt is ${attempt.status}, not stopped — there's nothing to override.` });
      return;
    }
    if (!attempt.outcome || !OVERRIDABLE_STOP_REASONS.has(attempt.outcome)) {
      res.status(409).json({
        error: `This attempt was stopped because of ${attempt.outcome ?? "a guardrail"} — that reason can't be overridden here.`,
      });
      return;
    }

    // A STOP action never had a real recovery action behind it to retry — fall back to Payment
    // Link, the safe manual default. Every other stop reason blocked an action that was already
    // decided (RETRY/PAYMENT_LINK), so re-running that same action is what "retry anyway" means.
    const overrideAction = attempt.action === "STOP" ? "PAYMENT_LINK" : attempt.action;
    const idempotencyKey = buildIdempotencyKey(attempt.paymentId, attempt.attemptNumber, overrideAction);

    await prisma.recoveryAttempt.update({
      where: { id: attempt.id },
      data: {
        action: overrideAction,
        idempotencyKey,
        status: "PENDING",
        outcome: null,
        approvalStatus: "NOT_REQUIRED",
        requiresApproval: false,
        // Persisted, not just passed to this one executeAttempt call — the merchant's eventual
        // approval click (or a bulk approve, or the scheduler) re-evaluates policy again later,
        // and needs to keep bypassing the same guardrails or it just gets stopped again.
        retryOverride: true,
      },
    });
    await writeAudit({
      merchantId: attempt.merchantId,
      paymentId: attempt.paymentId,
      attemptId: attempt.id,
      eventType: "RETRY_OVERRIDE_REQUESTED",
      action: overrideAction,
      failureReason: body.note,
    });

    const result = await executeAttempt(attempt.id, {
      retryOverride: true,
      ...(attempt.isSimulated ? { simulate: true } : {}),
    });
    res.json({ attempt: result });
  }),
);

