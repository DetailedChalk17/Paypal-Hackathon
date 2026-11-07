-- AlterTable
ALTER TABLE "Donation" ADD COLUMN     "completedAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" UUID NOT NULL,
    "paypalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "resourceId" TEXT,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_paypalEventId_key" ON "WebhookEvent"("paypalEventId");

-- CreateIndex
CREATE INDEX "WebhookEvent_eventType_receivedAt_idx" ON "WebhookEvent"("eventType", "receivedAt");
