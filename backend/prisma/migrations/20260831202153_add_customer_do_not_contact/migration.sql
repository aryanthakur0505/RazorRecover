-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "doNotContact" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "doNotContactAt" TIMESTAMP(3),
ADD COLUMN     "doNotContactReason" TEXT;
