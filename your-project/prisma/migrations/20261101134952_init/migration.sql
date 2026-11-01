-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('donor', 'organizer', 'reviewer');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('draft', 'active', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "MilestoneStatus" AS ENUM ('open', 'evidence_submitted', 'approved', 'rejected', 'paid');

-- CreateEnum
CREATE TYPE "DonationStatus" AS ENUM ('pending', 'completed', 'failed', 'refunded');

-- CreateEnum
CREATE TYPE "ReviewerDecision" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('pending', 'processing', 'paid', 'failed');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "role" "UserRole" NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "cause" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "payoutEmail" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "trustScore" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "organizerId" UUID,
    "title" TEXT NOT NULL,
    "goalAmountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "CampaignStatus" NOT NULL DEFAULT 'draft',

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Milestone" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "budgetAmountCents" INTEGER NOT NULL,
    "status" "MilestoneStatus" NOT NULL DEFAULT 'open',

    CONSTRAINT "Milestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Donation" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "donorId" UUID NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "paypalOrderId" TEXT,
    "paypalCaptureId" TEXT,
    "status" "DonationStatus" NOT NULL DEFAULT 'pending',

    CONSTRAINT "Donation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evidence" (
    "id" UUID NOT NULL,
    "milestoneId" UUID NOT NULL,
    "file" TEXT NOT NULL,
    "extractedFields" JSONB NOT NULL,
    "aiFindings" JSONB NOT NULL,
    "reviewerDecision" "ReviewerDecision" NOT NULL DEFAULT 'pending',

    CONSTRAINT "Evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" UUID NOT NULL,
    "milestoneId" UUID NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "senderBatchId" TEXT,
    "paypalBatchId" TEXT,
    "status" "PayoutStatus" NOT NULL DEFAULT 'pending',

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEvent" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "prevHash" TEXT,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Donation_paypalOrderId_key" ON "Donation"("paypalOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Donation_paypalCaptureId_key" ON "Donation"("paypalCaptureId");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_senderBatchId_key" ON "Payout"("senderBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_paypalBatchId_key" ON "Payout"("paypalBatchId");

-- CreateIndex
CREATE INDEX "LedgerEvent_entityId_createdAt_idx" ON "LedgerEvent"("entityId", "createdAt");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Milestone" ADD CONSTRAINT "Milestone_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Donation" ADD CONSTRAINT "Donation_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Donation" ADD CONSTRAINT "Donation_donorId_fkey" FOREIGN KEY ("donorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "Milestone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "Milestone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
