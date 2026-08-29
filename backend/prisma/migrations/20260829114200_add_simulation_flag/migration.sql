-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "isSimulated" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "isSimulated" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "RecoveryAttempt" ADD COLUMN     "isSimulated" BOOLEAN NOT NULL DEFAULT false;
