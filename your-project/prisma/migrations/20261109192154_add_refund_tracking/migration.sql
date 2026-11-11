-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('processing', 'pending', 'completed', 'failed', 'reconciliation_required');

-- CreateTable
CREATE TABLE "Refund" (
    "id" UUID NOT NULL,
    "donationId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "paypalRefundId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'processing',
    "noteToPayer" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Refund_paypalRefundId_key" ON "Refund"("paypalRefundId");

-- CreateIndex
CREATE INDEX "Refund_donationId_status_idx" ON "Refund"("donationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_donationId_idempotencyKey_key" ON "Refund"("donationId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_donationId_fkey" FOREIGN KEY ("donationId") REFERENCES "Donation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
