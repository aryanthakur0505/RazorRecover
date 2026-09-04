-- AlterTable
ALTER TABLE "RecoveryPolicy" ALTER COLUMN "maxRetries" SET DEFAULT 5,
ALTER COLUMN "retryDelayMinutes" SET DEFAULT '[0, 2880, 5760, 8640, 11520]';
