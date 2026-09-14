import { z } from "zod";

// Query-string `status` filters were previously cast straight through with `as any` and handed to
// Prisma, so an invalid value (a typo, or a client just probing) surfaced as a raw Prisma
// validation error via the generic 500 handler instead of a clean 400 naming what's actually
// wrong. Parsing against the real enum up front fixes that for free, via the same ZodError
// handling every other validated input already gets (see middleware/errorHandler.ts).
export const paymentStatusQuerySchema = z
  .enum(["CREATED", "AUTHORIZED", "CAPTURED", "FAILED", "REFUNDED"])
  .optional();

export const recoveryStatusQuerySchema = z
  .enum(["PENDING", "AWAITING_APPROVAL", "APPROVED", "REJECTED", "EXECUTING", "EXECUTED", "SUCCEEDED", "FAILED", "STOPPED"])
  .optional();

export const installmentPlanStatusQuerySchema = z
  .enum(["OFFERED", "ACTIVE", "COMPLETED", "DEFAULTED", "EXPIRED", "CANCELLED"])
  .optional();

export const approvalDecisionSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  note: z.string().max(500).optional(),
  // Optional, only meaningful when approving an ESCALATE attempt — logs what the customer
  // committed to on a follow-up call instead of resolving the attempt directly. Reuses the EMI
  // installment machinery with a single installment (see emiService.createPromisePlan).
  promise: z
    .object({
      dueDate: z.coerce.date(),
      amount: z.number().int().positive().optional(), // defaults to the full payment amount if omitted
    })
    .optional(),
});

export const policyUpdateSchema = z.object({
  maxRetries: z.number().int().min(0).max(10),
  maxAutoRecoveryAmount: z.number().int().min(0),
  maxCommunicationsPerPeriod: z.number().int().min(0).max(20),
  communicationPeriodHours: z.number().int().min(1).max(720),
  quietHoursStart: z.number().int().min(0).max(23),
  quietHoursEnd: z.number().int().min(0).max(23),
  minRetryIntervalMinutes: z.number().int().min(0).max(10080),
  retryDelayMinutes: z.array(z.number().int().min(0)).min(1).max(10),
});

export const simulationRequestSchema = z.object({
  size: z.union([z.literal(100), z.literal(500), z.literal(1000)]),
  seed: z.number().int().optional(),
});

export const executeAttemptSchema = z.object({
  attemptId: z.string().min(1),
});

export const escalationResolutionSchema = z.object({
  outcome: z.enum(["RECOVERED", "NOT_RECOVERED"]),
  note: z.string().max(500).optional(),
});

export const doNotContactUpdateSchema = z.object({
  doNotContact: z.boolean(),
  reason: z.string().max(500).optional(),
});

// Bulk approve/reject — capped well above any realistic single-click selection so a merchant
// can't accidentally (or deliberately) fire off an unbounded batch of Razorpay calls in one request.
export const bulkAttemptIdsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
  note: z.string().max(500).optional(),
});

// "Select all N matching this filter" — no id list at all, since the whole point is to act on
// more than could ever be loaded/selected client-side. The filter itself (status/q/date range) is
// still parsed from the query string, identically to GET /opportunities.
export const bulkActionRequestSchema = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().max(500).optional(),
});

export const customerNoteSchema = z.object({
  body: z.string().trim().min(1).max(2000),
});

export const retryOverrideSchema = z.object({
  note: z.string().max(500).optional(),
});
