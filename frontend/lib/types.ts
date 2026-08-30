// Mirrors the backend's Prisma-derived shapes for the subset of fields the UI reads.
// Kept intentionally loose (no shared package) per the project's simplicity constraints.

export type PaymentStatus = "CREATED" | "AUTHORIZED" | "CAPTURED" | "FAILED" | "REFUNDED";

export type FailureCategory =
  | "TEMPORARY_FAILURE"
  | "INSUFFICIENT_FUNDS"
  | "CHECKOUT_ABANDONED"
  | "EXPIRED_PAYMENT"
  | "SUSPICIOUS_PAYMENT"
  | "OTHER"
  | "NONE";

export type RecoveryAction = "RETRY" | "PAYMENT_LINK" | "STOP" | "ESCALATE";

export type RecoveryStatus =
  | "PENDING"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "EXECUTING"
  | "EXECUTED"
  | "SUCCEEDED"
  | "FAILED"
  | "STOPPED";

export type ApprovalStatus = "NOT_REQUIRED" | "PENDING" | "APPROVED" | "REJECTED";

export interface Customer {
  id: string;
  name: string;
  email: string;
}

export interface Payment {
  id: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  failureCategory: FailureCategory;
  isSuspicious: boolean;
  recoveryScore: number | null;
  scoreFactors: ScoreFactor[] | null;
  createdAt: string;
  customer: Customer;
}

export interface ScoreFactor {
  factor: string;
  impact: number;
  detail: string;
}

export interface PolicyCheck {
  rule: string;
  passed: boolean;
  detail: string;
}

export interface RecoveryAttempt {
  id: string;
  paymentId: string;
  merchantId: string;
  attemptNumber: number;
  action: RecoveryAction;
  status: RecoveryStatus;
  idempotencyKey: string;
  usedAI: boolean;
  aiOutput: {
    cause: string;
    confidence_score: number;
    risk_flags: string[];
    recommended_action: RecoveryAction;
    recommended_channel: string;
    decision_factors: { factor: string; detail: string }[];
  } | null;
  decisionFactors: ScoreFactor[] | null;
  riskFlags: string[] | null;
  policyChecks: PolicyCheck[] | null;
  requiresApproval: boolean;
  approvalStatus: ApprovalStatus;
  approvalNote: string | null;
  isSimulated: boolean;
  scheduledFor: string | null;
  executedAt: string | null;
  revenueRecovered: number | null;
  recoveryCost: number | null;
  netRecovered: number | null;
  outcome: string | null;
  createdAt: string;
  updatedAt: string;
  payment: Payment;
}

export interface AuditLogEntry {
  id: string;
  merchantId: string;
  paymentId: string | null;
  customerId: string | null;
  attemptId: string | null;
  eventType: string;
  timestamp: string;
  amount: number | null;
  failureReason: string | null;
  recoveryScore: number | null;
  decisionFactors: unknown;
  aiRecommendation: unknown;
  policyChecks: unknown;
  idempotencyKey: string | null;
  approvalStatus: string | null;
  action: string | null;
  apiResult: unknown;
  outcome: string | null;
  revenueRecovered: number | null;
  recoveryCost: number | null;
  netRecovered: number | null;
}

export interface RecoveryPolicy {
  id: string;
  merchantId: string;
  maxRetries: number;
  maxAutoRecoveryAmount: number;
  maxCommunicationsPerPeriod: number;
  communicationPeriodHours: number;
  quietHoursStart: number;
  quietHoursEnd: number;
  minRetryIntervalMinutes: number;
  retryDelayMinutes: number[];
}

export interface DashboardMetrics {
  revenueAtRisk: number;
  revenueRecovered: number;
  netRecoveredRevenue: number;
  recoveryCost: number;
  recoveryRate: number;
  costPerRecovery: number;
  netROI: number;
  totalAttempts: number;
  successfulRecoveries: number;
  failedRecoveries: number;
  pendingApprovals: number;
  agentStatus: "ONLINE" | "UNAVAILABLE";
  // Full payment book, not just recovery-related rows — the baseline "how much came through at all".
  totalPayments: number;
  successfulPayments: number;
  totalVolume: number;
  successfulVolume: number;
  baselineSuccessRate: number;
}

export interface ChartsResponse {
  revenueOverTime: { date: string; revenueRecovered: number; recoveryCost: number }[];
  byFailureType: { category: string; count: number }[];
  byAction: { action: string; count: number }[];
  outcomeBreakdown: { succeeded: number; failed: number };
}

export interface SimulationSummary {
  size: number;
  seed: number;
  paymentsAnalyzed: number;
  failedPayments: number;
  recoveryCandidates: number;
  recoveryAttemptsExecuted: number;
  successfulRecoveries: number;
  revenueAtRisk: number;
  revenueRecovered: number;
  recoveryCost: number;
  netRecoveredRevenue: number;
  recoveryRate: number;
  netROI: number;
}

export interface SimulationJob {
  status: "RUNNING" | "COMPLETED" | "FAILED";
  processed: number;
  total: number;
  result?: SimulationSummary;
  error?: string;
}

export interface AIShadowRow {
  attemptId: string;
  paymentId: string;
  customerName: string;
  amount: number;
  status: string;
  aiAction: RecoveryAction;
  aiConfidence: number;
  shadowAction: RecoveryAction;
  shadowConfidence: number;
  agreed: boolean;
  actualNetRecovered: number | null;
  estimatedShadowNet: number | null;
  delta: number | null;
}

export interface AIShadowComparison {
  totalAIAssisted: number;
  agreedCount: number;
  disagreedCount: number;
  agreementRate: number;
  resolvedDisagreements: number;
  estimatedIncrementalNet: number;
  rows: AIShadowRow[];
}
