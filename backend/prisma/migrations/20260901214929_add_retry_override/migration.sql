-- AlterTable
ALTER TABLE "RecoveryAttempt" ADD COLUMN     "retryOverride" BOOLEAN NOT NULL DEFAULT false;
