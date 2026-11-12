
import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "../src/lib/prisma";
import { releasePayout } from "../src/services/payout.service";

const milestoneId = "test-milestone-id";

function makeMilestone(
  status: string,
  currency = "USD"
) {
  return {
    id: milestoneId,
    campaignId: "test-campaign-id",
    status,
    budgetAmountCents: 10000,
    campaign: {
      currency,
      organization: {
        id: "test-organization-id",
        payoutEmail: "recipient@example.com",
      },
    },
  };
}


function replaceMethod(
  target: object,
  methodName: string,
  replacement: (...args: any[]) => any
) {
  const methods = target as Record<string, unknown>;
  const original = methods[methodName];

  methods[methodName] = replacement;

  return () => {
    methods[methodName] = original;
  };
}


function setupPayoutTest(
  initialPayout: Record<string, any> | null = null
) {
  const restores: Array<() => void> = [];
  const ledgerEvents: Record<string, any>[] = [];

  const state: {
    payoutRecord: Record<string, any> | null;
    senderCalls: number;
  } = {
    payoutRecord: initialPayout
      ? { ...initialPayout }
      : null,
    senderCalls: 0,
  };

  const tx = {
    $queryRaw: async () => [{ locked: true }],

    payout: {
      findUnique: async () => state.payoutRecord,

      create: async ({ data }: any) => {
        state.payoutRecord = {
          id: "test-payout-id",
          ...data,
        };
        return state.payoutRecord;
      },

      updateMany: async ({ where, data }: any) => {
        const current = state.payoutRecord;

        if (!current) return { count: 0 };

        for (const [key, value] of Object.entries(where)) {
          if (key === "id" && current.id !== value) {
            return { count: 0 };
          }

          if (
            key === "status" &&
            typeof value === "string" &&
            current.status !== value
          ) {
            return { count: 0 };
          }

          if (
            (key === "submittedAt" || key === "paypalBatchId") &&
            value === null &&
            current[key] != null
          ) {
            return { count: 0 };
          }
        }

        state.payoutRecord = { ...current, ...data };
        return { count: 1 };
      },

      findUniqueOrThrow: async () => {
        if (!state.payoutRecord) {
          throw new Error("Payout not found");
        }
        return state.payoutRecord;
      },
    },

    ledgerEvent: {
      findFirst: async () => null,

      create: async ({ data }: any) => {
        const event = {
          id: `ledger-${ledgerEvents.length + 1}`,
          ...data,
        };
        ledgerEvents.push(event);
        return event;
      },
    },
  };

  restores.push(
    replaceMethod(
      prisma.milestone,
      "findUnique",
      async () => makeMilestone("approved")
    )
  );

  restores.push(
    replaceMethod(
      prisma.payout,
      "findUnique",
      async () => state.payoutRecord
    )
  );

  restores.push(
    replaceMethod(
      prisma as object,
      "$transaction",
      async (callback: any) => callback(tx)
    )
  );

  return {
    state,
    ledgerEvents,
    restores,
    sender: async (_input: any) => {
      state.senderCalls++;
      return {
        success: true,
        senderBatchId: _input.senderBatchId,
        paypalBatchId: "PAYPAL-BATCH-TEST-123",
        message: "Mock payout submitted successfully",
      };
    },
    cleanup: () => {
      restores.reverse().forEach((restore) => restore());
    },
  };
}


test("Missing milestone is rejected", async (t) => {
  const restore = replaceMethod(
    prisma.milestone,
    "findUnique",
    async () => null
  );

  t.after(restore);

  await assert.rejects(
    releasePayout(milestoneId),
    /Milestone not found/
  );
});


test("Unapproved milestone cannot trigger payout", async (t) => {
  const restoreMilestone = replaceMethod(
    prisma.milestone,
    "findUnique",
    async () => makeMilestone("open")
  );

  const restorePayout = replaceMethod(
    prisma.payout,
    "findUnique",
    async () => null
  );

  t.after(restoreMilestone);
  t.after(restorePayout);

  await assert.rejects(
    releasePayout(milestoneId),
    /Milestone must be approved/
  );
});


test("Non-USD campaign cannot trigger payout", async (t) => {
  const restoreMilestone = replaceMethod(
    prisma.milestone,
    "findUnique",
    async () => makeMilestone("approved", "INR")
  );

  const restorePayout = replaceMethod(
    prisma.payout,
    "findUnique",
    async () => null
  );

  t.after(restoreMilestone);
  t.after(restorePayout);

  await assert.rejects(
    releasePayout(milestoneId),
    /USD only/
  );
});


test("Approved USD milestone submits payout and stores PayPal batch ID", async (t) => {
  const restores: Array<() => void> = [];

  const testState: {
  payoutRecord: Record<string, any> | null;
  senderInput: Record<string, any> | null;
} = {
  payoutRecord: null,
  senderInput: null,
};

const ledgerEvents: Record<string, any>[] = [];

  const tx = {
    $queryRaw: async () => [{ locked: true }],

    milestone: {},

    payout: {
      findUnique: async () => testState.payoutRecord,

      create: async ({ data }: any) => {
        testState.payoutRecord = {
          id: "test-payout-id",
          ...data,
        };
        return testState.payoutRecord;
      },

      updateMany: async ({ where, data }: any) => {
        if (!testState.payoutRecord) return { count: 0 };

        if (
          where.status &&
          testState.payoutRecord.status !== where.status
        ) {
          return { count: 0 };
        }

        testState.payoutRecord = { ...testState.payoutRecord, ...data };
        return { count: 1 };
      },

      findUniqueOrThrow: async () => {
        if (!testState.payoutRecord) throw new Error("Payout not found");
        return testState.payoutRecord;
      },
    },

    ledgerEvent: {
      findFirst: async () => null,

      create: async ({ data }: any) => {
        const event = {
          id: `ledger-${ledgerEvents.length + 1}`,
          ...data,
        };
        ledgerEvents.push(event);
        return event;
      },
    },
  };

  restores.push(
    replaceMethod(
      prisma.milestone,
      "findUnique",
      async () => makeMilestone("approved")
    )
  );

  restores.push(
    replaceMethod(
      prisma.payout,
      "findUnique",
      async () => testState.payoutRecord
    )
  );

  restores.push(
    replaceMethod(
      prisma as object,
      "$transaction",
      async (callback: any) => callback(tx)
    )
  );

  t.after(() => {
    restores.reverse().forEach((restore) => restore());
  });

  const mockSender = async (input: any) => {
    testState.senderInput = input;

    return {
      success: true,
      senderBatchId: input.senderBatchId,
      paypalBatchId: "PAYPAL-BATCH-TEST-123",
      message: "Mock payout submitted successfully",
    };
  };

  const result = await releasePayout(milestoneId, mockSender);

const submittedInput = testState.senderInput;
const finalPayout = testState.payoutRecord;



assert.ok(submittedInput);
assert.ok(finalPayout);

// Sender input
assert.equal(submittedInput.amountCents, 10000);
assert.equal(submittedInput.recipientEmail, "recipient@example.com");
assert.ok(submittedInput.senderBatchId.startsWith("p_"));

// Final payout state
assert.equal(finalPayout.status, "processing");
assert.equal(finalPayout.amountCents, 10000);
assert.equal(finalPayout.paypalBatchId, "PAYPAL-BATCH-TEST-123");

// Service result
assert.equal(result.status, "processing");
assert.equal(result.paypalBatchId, "PAYPAL-BATCH-TEST-123");

assert.ok(
  ledgerEvents.some(
    (event) => event.type === "PAYOUT_INITIATED"
  )
);

assert.ok(
  ledgerEvents.some(
    (event) => event.type === "PAYOUT_BATCH_SUBMITTED"
  )
);
});


test("Definitive payout rejection marks payout as failed", async (t) => {
  const mock = setupPayoutTest();

  t.after(mock.cleanup);

  const rejectingSender = async (input: any) => {
    mock.state.senderCalls++;

    return {
      success: false,
      senderBatchId: input.senderBatchId,
      message: "PayPal authentication failed",
      failureKind: "definitive" as const,
    };
  };

  await assert.rejects(
    releasePayout(milestoneId, rejectingSender),
    /PayPal authentication failed/
  );

  assert.equal(mock.state.payoutRecord?.status, "failed");
  assert.equal(mock.state.senderCalls, 1);

  assert.ok(
    mock.ledgerEvents.some(
      (event) => event.type === "PAYOUT_FAILED"
    )
  );
});


test("Unknown payout outcome requires reconciliation", async (t) => {
  const mock = setupPayoutTest();

  t.after(mock.cleanup);

  const uncertainSender = async (input: any) => {
    mock.state.senderCalls++;

    return {
      success: false,
      senderBatchId: input.senderBatchId,
      message: "Request timed out",
      failureKind: "unknown" as const,
    };
  };

  await assert.rejects(
    releasePayout(milestoneId, uncertainSender),
    /outcome is unknown; reconciliation required/
  );

  assert.equal(
    mock.state.payoutRecord?.status,
    "reconciliation_required"
  );

  assert.equal(mock.state.senderCalls, 1);

  assert.ok(
    mock.ledgerEvents.some(
      (event) => event.type === "PAYOUT_OUTCOME_UNKNOWN"
    )
  );
});


test("Existing active payout states never trigger another submission", async (t) => {
  const statuses = [
    "processing",
    "paid",
    "reconciliation_required",
  ];

  for (const status of statuses) {
    const mock = setupPayoutTest({
      id: "test-payout-id",
      milestoneId,
      amountCents: 10000,
      senderBatchId: "p_existing_batch",
      paypalBatchId:
        status === "paid" ? "PAYPAL-BATCH-EXISTING" : null,
      submittedAt: status === "paid" ? new Date() : null,
      status,
    });

    try {
      const result = await releasePayout(milestoneId, mock.sender);

      assert.equal(result.status, status);
      assert.equal(
        mock.state.senderCalls,
        0,
        `Sender should not be called for ${status}`
      );
    } finally {
      mock.cleanup();
    }
  }
});


test("Concurrent payout requests allow only one submission", async (t) => {
  const mock = setupPayoutTest({
    id: "test-payout-id",
    milestoneId,
    amountCents: 10000,
    senderBatchId: "p_existing_batch",
    paypalBatchId: null,
    submittedAt: null,
    status: "pending",
  });

  t.after(mock.cleanup);

  let releaseSender!: () => void;

  const senderGate = new Promise<void>((resolve) => {
    releaseSender = resolve;
  });

  const controlledSender = async (input: any) => {
    mock.state.senderCalls++;

    // Keep the first submission in progress while the
    // second request attempts to claim the same payout.
    await senderGate;

    return {
      success: true,
      senderBatchId: input.senderBatchId,
      paypalBatchId: "PAYPAL-BATCH-CONCURRENT-TEST",
      message: "Mock payout submitted successfully",
    };
  };

  const firstRequest = releasePayout(
    milestoneId,
    controlledSender
  );

  const secondRequest = releasePayout(
    milestoneId,
    controlledSender
  );

  // Allow both requests to attempt their payout claim.
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(
    mock.state.senderCalls,
    1,
    "Only one request should reach the payout sender"
  );

  releaseSender();

  const [firstResult, secondResult] = await Promise.all([
    firstRequest,
    secondRequest,
  ]);

  assert.equal(firstResult.status, "processing");
  assert.equal(secondResult.status, "processing");
  assert.equal(mock.state.senderCalls, 1);
});


test(
  "API response preserves a state established during PayPal submission",
  async (t) => {
    const webhookEstablishedStates = [
      "failed",
      "reconciliation_required",
      "paid",
    ];

    for (const webhookStatus of webhookEstablishedStates) {
      const mock = setupPayoutTest();

      try {
        const racingSender = async (input: any) => {
          mock.state.senderCalls++;

          // Simulate a webhook arriving while the PayPal
          // API request is still awaiting its response.
          mock.state.payoutRecord!.status = webhookStatus;

          return {
            success: true,
            senderBatchId: input.senderBatchId,
            paypalBatchId: "PAYPAL-BATCH-RACE-123",
            message: "Mock payout submitted successfully",
          };
        };

        const result = await releasePayout(
          milestoneId,
          racingSender
        );

        assert.equal(
          result.status,
          webhookStatus,
          `Webhook-established ${webhookStatus} state must be preserved`
        );

        assert.equal(
          mock.state.payoutRecord?.status,
          webhookStatus
        );

        assert.equal(
          mock.state.payoutRecord?.paypalBatchId,
          "PAYPAL-BATCH-RACE-123"
        );

        assert.ok(
          mock.state.payoutRecord?.submittedAt,
          "Submission timestamp should still be recorded"
        );

        assert.equal(mock.state.senderCalls, 1);

        assert.ok(
          mock.ledgerEvents.some(
            (event) => event.type === "PAYOUT_BATCH_SUBMITTED"
          )
        );
      } finally {
        mock.cleanup();
      }
    }
  }
);
