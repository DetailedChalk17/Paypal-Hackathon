-- AlterEnum
ALTER TYPE "PayoutStatus" ADD VALUE 'reconciliation_required';

-- AlterTable
ALTER TABLE "Payout" ADD COLUMN     "submissionAttemptStartedAt" TIMESTAMPTZ(3),
ADD COLUMN     "submittedAt" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "Payout_status_submissionAttemptStartedAt_idx" ON "Payout"("status", "submissionAttemptStartedAt");
