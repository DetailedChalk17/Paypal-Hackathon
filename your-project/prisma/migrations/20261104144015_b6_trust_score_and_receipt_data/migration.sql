-- AlterTable
ALTER TABLE "Evidence" ADD COLUMN     "submittedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Milestone" ADD COLUMN     "dueDate" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "trustScoreBreakdown" JSONB,
ADD COLUMN     "trustScoreUpdatedAt" TIMESTAMPTZ(3);
