-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN     "email" TEXT,
ADD COLUMN     "passwordHash" TEXT,
ADD COLUMN     "razorpayKeyId" TEXT,
ADD COLUMN     "razorpayKeySecretEncrypted" TEXT,
ADD COLUMN     "razorpayWebhookSecretEncrypted" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_email_key" ON "Merchant"("email");

