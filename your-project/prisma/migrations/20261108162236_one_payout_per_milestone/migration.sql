/*
  Warnings:

  - A unique constraint covering the columns `[milestoneId]` on the table `Payout` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Payout_milestoneId_key" ON "Payout"("milestoneId");
