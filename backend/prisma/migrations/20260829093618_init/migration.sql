-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "FailureCategory" AS ENUM ('TEMPORARY_FAILURE', 'INSUFFICIENT_FUNDS', 'CHECKOUT_ABANDONED', 'EXPIRED_PAYMENT', 'SUSPICIOUS_PAYMENT', 'OTHER', 'NONE');

-- CreateEnum
CREATE TYPE "RecoveryAction" AS ENUM ('RETRY', 'PAYMENT_LINK', 'STOP', 'ESCALATE');

-- CreateEnum
CREATE TYPE "RecoveryStatus" AS ENUM ('PENDING', 'AWAITING_APPROVAL', 'APPROVED', 'REJECTED', 'EXECUTING', 'EXECUTED', 'SUCCEEDED', 'FAILED', 'STOPPED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "Merchant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "externalRef" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "razorpayPaymentId" TEXT,
    "razorpayOrderId" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "failureReasonRaw" TEXT,
    "failureCategory" "FailureCategory" NOT NULL DEFAULT 'NONE',
    "isSuspicious" BOOLEAN NOT NULL DEFAULT false,
    "recoveryScore" INTEGER,
    "scoreFactors" JSONB,
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryAttempt" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "action" "RecoveryAction" NOT NULL,
    "status" "RecoveryStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "usedAI" BOOLEAN NOT NULL DEFAULT false,
    "aiOutput" JSONB,
    "decisionFactors" JSONB,
    "riskFlags" JSONB,
    "policyChecks" JSONB,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "approvalNote" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "razorpayResponse" JSONB,
    "revenueRecovered" INTEGER,
    "recoveryCost" INTEGER,
    "netRecovered" INTEGER,
    "outcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecoveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryPolicy" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "maxAutoRecoveryAmount" INTEGER NOT NULL DEFAULT 500000,
    "maxCommunicationsPerPeriod" INTEGER NOT NULL DEFAULT 2,
    "communicationPeriodHours" INTEGER NOT NULL DEFAULT 72,
    "quietHoursStart" INTEGER NOT NULL DEFAULT 22,
    "quietHoursEnd" INTEGER NOT NULL DEFAULT 8,
    "minRetryIntervalMinutes" INTEGER NOT NULL DEFAULT 60,
    "retryDelayMinutes" JSONB NOT NULL DEFAULT '[0, 360, 1440]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecoveryPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "paymentId" TEXT,
    "customerId" TEXT,
    "attemptId" TEXT,
    "eventType" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "amount" INTEGER,
    "failureReason" TEXT,
    "recoveryScore" INTEGER,
    "decisionFactors" JSONB,
    "aiRecommendation" JSONB,
    "policyChecks" JSONB,
    "idempotencyKey" TEXT,
    "approvalStatus" TEXT,
    "action" TEXT,
    "apiResult" JSONB,
    "outcome" TEXT,
    "revenueRecovered" INTEGER,
    "recoveryCost" INTEGER,
    "netRecovered" INTEGER,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "razorpayEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Customer_merchantId_idx" ON "Customer"("merchantId");

-- CreateIndex
CREATE INDEX "Payment_merchantId_status_idx" ON "Payment"("merchantId", "status");

-- CreateIndex
CREATE INDEX "Payment_customerId_idx" ON "Payment"("customerId");

-- CreateIndex
CREATE INDEX "Payment_merchantId_failureCategory_idx" ON "Payment"("merchantId", "failureCategory");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryAttempt_idempotencyKey_key" ON "RecoveryAttempt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "RecoveryAttempt_paymentId_idx" ON "RecoveryAttempt"("paymentId");

-- CreateIndex
CREATE INDEX "RecoveryAttempt_merchantId_status_idx" ON "RecoveryAttempt"("merchantId", "status");

-- CreateIndex
CREATE INDEX "RecoveryAttempt_scheduledFor_idx" ON "RecoveryAttempt"("scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryPolicy_merchantId_key" ON "RecoveryPolicy"("merchantId");

-- CreateIndex
CREATE INDEX "AuditLog_merchantId_timestamp_idx" ON "AuditLog"("merchantId", "timestamp");

-- CreateIndex
CREATE INDEX "AuditLog_paymentId_idx" ON "AuditLog"("paymentId");

-- CreateIndex
CREATE INDEX "AuditLog_attemptId_idx" ON "AuditLog"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_razorpayEventId_key" ON "WebhookEvent"("razorpayEventId");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryPolicy" ADD CONSTRAINT "RecoveryPolicy_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "RecoveryAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
