import assert from "node:assert/strict";
import test from "node:test";

import { calculateTrustScore } from "../src/services/trust-score.service";

const now = new Date("2026-11-04T12:00:00.000Z");

function makeEvidence(
  reviewerDecision: string,
  submittedAt: string,
  ledgerApproved = false
) {
  return {
    reviewerDecision,
    submittedAt: new Date(submittedAt),
    ledgerApproved,
  };
}

function makeMilestone(
  status: string,
  dueDate: string | null,
  budgetAmountCents: number,
  evidence: ReturnType<typeof makeEvidence>[] = [],
  successfulPayout = false
) {
  return {
    status,
    dueDate: dueDate ? new Date(dueDate) : null,
    budgetAmountCents,
    evidence,
    payouts: successfulPayout
      ? [{ id: "test-payout", ledgerSucceeded: true }]
      : [],
  };
}

// SAMPLE 1: Excellent organization
const excellentCampaign = [
  {
    goalAmountCents: 100000,
    milestones: [
      makeMilestone(
        "paid",
        "2026-10-20T12:00:00.000Z",
        40000,
        [
          makeEvidence(
            "approved",
            "2026-10-19T12:00:00.000Z",
            true
          ),
        ],
        true
      ),
      makeMilestone(
        "paid",
        "2026-10-30T12:00:00.000Z",
        50000,
        [
          makeEvidence(
            "approved",
            "2026-10-29T12:00:00.000Z",
            true
          ),
        ],
        true
      ),
    ],
  },
];

// SAMPLE 2: Mixed performance
const averageCampaign = [
  {
    goalAmountCents: 100000,
    milestones: [
      makeMilestone(
        "open",
        "2026-10-20T12:00:00.000Z",
        70000,
        [
          makeEvidence(
            "pending",
            "2026-10-19T12:00:00.000Z"
          ),
        ]
      ),
      makeMilestone(
        "paid",
        "2026-10-21T12:00:00.000Z",
        50000,
        [
          makeEvidence(
            "approved",
            "2026-10-23T12:00:00.000Z",
            true
          ),
        ],
        true
      ),
    ],
  },
];

// SAMPLE 3: Missing historical deadline data
const incompleteCampaign = [
  {
    goalAmountCents: 100000,
    milestones: [
      makeMilestone("open", null, 100000),
    ],
  },
];

test("Sample 1: Excellent organization receives 100", () => {
  const result = calculateTrustScore(excellentCampaign, now);

  assert.equal(result.score, 100);
  assert.equal(result.coveragePercent, 100);
  assert.equal(result.components.approvedWithEvidence.earnedPoints, 40);
  assert.equal(result.components.onTimeUpdates.earnedPoints, 20);
  assert.equal(result.components.budgetCompliance.earnedPoints, 20);
  assert.equal(result.components.completedMilestones.earnedPoints, 20);
});

test("Sample 2: Mixed performance receives 40", () => {
  const result = calculateTrustScore(averageCampaign, now);

  assert.equal(result.score, 40);
  assert.equal(result.components.approvedWithEvidence.earnedPoints, 20);
  assert.equal(result.components.onTimeUpdates.earnedPoints, 10);
  assert.equal(result.components.budgetCompliance.earnedPoints, 0);
  assert.equal(result.components.completedMilestones.earnedPoints, 10);
});

test("Sample 3: Missing deadlines reduces score coverage", () => {
  const result = calculateTrustScore(incompleteCampaign, now);

  assert.equal(result.score, 25);
  assert.equal(result.coveragePercent, 80);
  assert.equal(result.components.onTimeUpdates.applicable, false);
});

test("Empty campaign list returns zero without errors", () => {
  const result = calculateTrustScore([], now);

  assert.equal(result.score, 0);
  assert.equal(result.availablePoints, 0);
  assert.equal(result.coveragePercent, 0);
});