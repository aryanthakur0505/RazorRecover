/*
  Warnings:

  - You are about to drop the column `emiTenureMonths` on the `RecoveryAttempt` table. All the data in the column will be lost.

*/
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "InstallmentPlanStatus" ADD VALUE 'OFFERED';
ALTER TYPE "InstallmentPlanStatus" ADD VALUE 'EXPIRED';

-- AlterTable
ALTER TABLE "InstallmentPlan" ADD COLUMN     "offerExpiresAt" TIMESTAMP(3),
ALTER COLUMN "tenureMonths" DROP NOT NULL,
ALTER COLUMN "totalInterest" DROP NOT NULL,
ALTER COLUMN "totalPayable" DROP NOT NULL,
ALTER COLUMN "monthlyAmount" DROP NOT NULL;

-- AlterTable
ALTER TABLE "RecoveryAttempt" DROP COLUMN "emiTenureMonths";

-- CreateIndex
CREATE INDEX "InstallmentPlan_status_offerExpiresAt_idx" ON "InstallmentPlan"("status", "offerExpiresAt");
