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
  doNotContact: boolean;
  doNotContactReason: string | null;
  doNotContactAt: string | null;
}

export interface CustomerDetail extends Customer {
  externalRef: string | null;
  isSimulated: boolean;
  createdAt: string;
}

export interface CustomerProfileAttempt {
  id: string;
  attemptNumber: number;
  action: RecoveryAction;
  status: RecoveryStatus;
  outcome: string | null;
  usedAI: boolean;
  revenueRecovered: number | null;
  netRecovered: number | null;
  createdAt: string;
}

export interface CustomerProfilePayment {
  id: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  failureCategory: FailureCategory;
  recoveryScore: number | null;
  createdAt: string;
  attempts: CustomerProfileAttempt[];
}

export interface CustomerProfileStats {
  totalPayments: number;
  successfulPayments: number;
  failedPayments: number;
  lifetimeValue: number;
  totalRecoveryAttempts: number;
  successfulRecoveries: number;
  revenueRecovered: number;
  recoveryRate: number | null;
  customerSince: string;
}

export interface CustomerNote {
  id: string;
  customerId: string;
  body: string;
  createdAt: string;
}

export interface CustomerProfile {
  customer: CustomerDetail;
  stats: CustomerProfileStats;
  payments: CustomerProfilePayment[];
  notes: CustomerNote[];
}

export interface CustomerSearchResult {
  id: string;
  name: string;
  email: string;
  doNotContact: boolean;
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

export interface OutcomeFunnel {
  totalFailedCount: number;
  totalFailedAmount: number;
  attemptedCount: number;
  attemptedAmount: number;
  recoveredCount: number;
  recoveredAmount: number;
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
  aiEscalatedCount: number;
}

export interface SimulationJob {
  status: "RUNNING" | "COMPLETED" | "FAILED";
  processed: number;
  total: number;
  result?: SimulationSummary;
  error?: string;
}

export interface BulkJob {
  status: "RUNNING" | "COMPLETED" | "FAILED";
  action: "approve" | "reject";
  processed: number;
  total: number;
  succeeded: number;
  failed: number;
  errors: { id: string; error: string }[];
  truncated: boolean;
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
  engineWouldHaveMissedThis: boolean;
}

export interface AIShadowComparison {
  totalAIAssisted: number;
  agreedCount: number;
  disagreedCount: number;
  agreementRate: number;
  resolvedDisagreements: number;
  estimatedIncrementalNet: number;
  revenueFoundByAI: number;
  casesFoundByAI: number;
  rows: AIShadowRow[];
}

export interface ConfidenceBucket {
  label: string;
  min: number;
  max: number;
  count: number;
  avgStatedConfidence: number | null;
  actualSuccessRate: number | null;
}

export interface AIConfidenceCalibration {
  totalResolved: number;
  buckets: ConfidenceBucket[];
  avgConfidenceWhenSucceeded: number | null;
  avgConfidenceWhenFailed: number | null;
}

// ---------------------------------------------------------------------------
// EMI / promise-to-pay plans — a promise is just a plan with tenureMonths === 1 and 0% interest,
// so one set of types (and one page) covers both. See backend emiService.ts.
// ---------------------------------------------------------------------------

// OFFERED = 6/12/24-month options sent, customer hasn't picked one yet. ACTIVE = tenure chosen
// (or a promise, which skips the offer stage entirely). EXPIRED = customer never responded within
// the window — reverts to normal recovery. See backend emiService.ts.
export type InstallmentPlanStatus = "OFFERED" | "ACTIVE" | "COMPLETED" | "DEFAULTED" | "EXPIRED" | "CANCELLED";
export type InstallmentStatus = "PENDING" | "PAID" | "MISSED";

export interface Installment {
  id: string;
  installmentNumber: number;
  dueDate: string;
  amount: number;
  status: InstallmentStatus;
  paidAt: string | null;
}

// tenureMonths/totalInterest/totalPayable/monthlyAmount are all null while OFFERED — the schedule
// isn't known until the customer picks a tenure.
export interface InstallmentPlanListRow {
  id: string;
  customer: { id: string; name: string; email: string };
  paymentId: string;
  principalAmount: number;
  tenureMonths: number | null;
  annualInterestRateBps: number;
  totalInterest: number | null;
  totalPayable: number | null;
  monthlyAmount: number | null;
  status: InstallmentPlanStatus;
  startDate: string;
  offerExpiresAt: string | null;
  paidCount: number;
  missedCount: number;
  pendingCount: number;
}

export interface InstallmentPlanDetail {
  id: string;
  paymentId: string;
  customerId: string;
  attemptId: string;
  principalAmount: number;
  tenureMonths: number | null;
  annualInterestRateBps: number;
  totalInterest: number | null;
  totalPayable: number | null;
  monthlyAmount: number | null;
  status: InstallmentPlanStatus;
  startDate: string;
  offerExpiresAt: string | null;
  createdAt: string;
  customer: { id: string; name: string; email: string };
  payment: { id: string; amount: number; failureCategory: string; failedAt: string | null };
  installments: Installment[];
}

// ---------------------------------------------------------------------------
// Re-engagement — payments stopped for repeated-contact reasons, classified by their most recent
// attempt (see backend routes/recovery.ts's /re-engagement endpoint).
// ---------------------------------------------------------------------------

export interface ReEngagementRow {
  paymentId: string;
  customer: { id: string; name: string; email: string };
  amount: number;
  failureCategory: string;
  attemptNumber: number;
  lastAttemptAt: string;
  // Only set for the "cooling down" bucket — when the 72h (or whatever the policy says) window
  // will roll over and the scheduler will automatically retry this. Null for "exhausted" (nothing
  // will retry this on its own anymore) or if it's already eligible right now.
  nextEligibleAt: string | null;
}
