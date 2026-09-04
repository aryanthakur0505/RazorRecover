-- CreateIndex
CREATE UNIQUE INDEX "Customer_merchantId_externalRef_key" ON "Customer"("merchantId", "externalRef");
