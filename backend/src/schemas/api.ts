import { z } from "zod";

export const approvalDecisionSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  note: z.string().max(500).optional(),
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
