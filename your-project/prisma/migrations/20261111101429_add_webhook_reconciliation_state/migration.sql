-- AlterTable
ALTER TABLE "WebhookEvent" ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "processingStatus" TEXT NOT NULL DEFAULT 'received';

-- CreateIndex
CREATE INDEX "WebhookEvent_processingStatus_receivedAt_idx" ON "WebhookEvent"("processingStatus", "receivedAt");
