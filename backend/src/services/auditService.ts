import { prisma } from "../db";
import { Prisma } from "@prisma/client";

export interface AuditEntryInput {
  merchantId: string;
  paymentId?: string;
  customerId?: string;
  attemptId?: string;
  eventType: string;
  amount?: number;
  failureReason?: string;
  recoveryScore?: number;
  decisionFactors?: unknown;
  aiRecommendation?: unknown;
  policyChecks?: unknown;
  idempotencyKey?: string;
  approvalStatus?: string;
  action?: string;
  apiResult?: unknown;
  outcome?: string;
  revenueRecovered?: number;
  recoveryCost?: number;
  netRecovered?: number;
}

/** Append-only audit trail writer. No update/delete path is ever exposed anywhere in the app. */
export async function writeAudit(entry: AuditEntryInput) {
  return prisma.auditLog.create({
    data: {
      merchantId: entry.merchantId,
      paymentId: entry.paymentId,
      customerId: entry.customerId,
      attemptId: entry.attemptId,
      eventType: entry.eventType,
      amount: entry.amount,
      failureReason: entry.failureReason,
      recoveryScore: entry.recoveryScore,
      decisionFactors: entry.decisionFactors as Prisma.InputJsonValue,
      aiRecommendation: entry.aiRecommendation as Prisma.InputJsonValue,
      policyChecks: entry.policyChecks as Prisma.InputJsonValue,
      idempotencyKey: entry.idempotencyKey,
      approvalStatus: entry.approvalStatus,
      action: entry.action,
      apiResult: entry.apiResult as Prisma.InputJsonValue,
      outcome: entry.outcome,
      revenueRecovered: entry.revenueRecovered,
      recoveryCost: entry.recoveryCost,
      netRecovered: entry.netRecovered,
    },
  });
}
