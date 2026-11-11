
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPayout, getPayoutStatus } from "./payouts.js";


const originalFetch = globalThis.fetch;

const originalEnv = {
  PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET,
  PAYPAL_ENV: process.env.PAYPAL_ENV,
};

let fetchCalls: Array<{
  url: string;
  options?: RequestInit;
}> = [];

let mockResponse: unknown;
let mockStatus = 200;

function mockFetch(): void {
  globalThis.fetch = (async (input, init) => {
    const url = String(input);

    fetchCalls.push({
      url,
      options: init,
    });

    if (url.includes("/v1/oauth2/token")) {
      return new Response(
        JSON.stringify({
          access_token: "mock-access-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    return new Response(JSON.stringify(mockResponse), {
      status: mockStatus,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}


const validInput = {
  receiverEmail: "recipient@example.com",
  amountCents: 1250,
  senderBatchId: "p_testbatch123",
  senderItemId: "i_testitem123",
};

describe("PayPal payout adapter", () => {
beforeEach(() => {
  process.env.PAYPAL_CLIENT_ID = "mock-client-id";
  process.env.PAYPAL_CLIENT_SECRET = "mock-client-secret";
  process.env.PAYPAL_ENV = "sandbox";

  fetchCalls = [];
  mockStatus = 200;
  mockResponse = {};
  mockFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;

  for (const key of Object.keys(originalEnv) as Array<
    keyof typeof originalEnv
  >) {
    const value = originalEnv[key];

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});


  it("creates a payout with the expected USD amount and request ID", async () => {
    mockResponse = {
      batch_header: {
        payout_batch_id: "BATCH-123",
        batch_status: "PENDING",
      },
    };

    const result = await createPayout(validInput);

    assert.equal(result.payoutBatchId, "BATCH-123");
    assert.equal(result.senderBatchId, validInput.senderBatchId);
    assert.equal(result.senderItemId, validInput.senderItemId);
    assert.equal(result.amount, "12.50");
    assert.equal(result.currency, "USD");
    assert.equal(result.status, "PENDING");

    // First request is the OAuth token request.
    // Second request is the payout request.
    const payoutCall = fetchCalls.find((call) =>
      call.url.endsWith("/v1/payments/payouts")
    );

    assert.ok(payoutCall, "Expected a PayPal payout API request");

    assert.equal(
      payoutCall.url,
      "https://api-m.sandbox.paypal.com/v1/payments/payouts"
    );

    const headers = new Headers(payoutCall.options?.headers);

    assert.equal(
      headers.get("PayPal-Request-Id"),
      validInput.senderBatchId
    );

    const body = JSON.parse(String(payoutCall.options?.body));

    assert.equal(
      body.items[0].amount.value,
      "12.50"
    );

    assert.equal(
      body.items[0].amount.currency,
      "USD"
    );

    assert.equal(
      body.items[0].sender_item_id,
      validInput.senderItemId
    );

    assert.equal(
      body.items[0].receiver,
      validInput.receiverEmail
    );
  });

  it("rejects an invalid recipient email before making requests", async () => {
    await assert.rejects(
      () =>
        createPayout({
          ...validInput,
          receiverEmail: "not-an-email",
        }),
      /valid recipient email/i
    );

    assert.equal(fetchCalls.length, 0);
  });

  it("rejects zero payout amounts", async () => {
    await assert.rejects(
      () =>
        createPayout({
          ...validInput,
          amountCents: 0,
        }),
      /positive integer cents/i
    );

    assert.equal(fetchCalls.length, 0);
  });

  it("rejects negative payout amounts", async () => {
    await assert.rejects(
      () =>
        createPayout({
          ...validInput,
          amountCents: -100,
        }),
      /positive integer cents/i
    );

    assert.equal(fetchCalls.length, 0);
  });

  it("rejects non-integer payout amounts", async () => {
    await assert.rejects(
      () =>
        createPayout({
          ...validInput,
          amountCents: 100.5,
        }),
      /positive integer cents/i
    );

    assert.equal(fetchCalls.length, 0);
  });

  it("rejects invalid sender batch IDs", async () => {
    await assert.rejects(
      () =>
        createPayout({
          ...validInput,
          senderBatchId: "",
        }),
      /Sender batch ID/i
    );

    assert.equal(fetchCalls.length, 0);
  });

  it("rejects whitespace-only sender batch IDs", async () => {
  await assert.rejects(
    () =>
      createPayout({
        ...validInput,
        senderBatchId: "   ",
      }),
    /Sender batch ID/i
  );

  assert.equal(fetchCalls.length, 0);
});

  it("rejects sender item IDs longer than 30 characters", async () => {
    await assert.rejects(
      () =>
        createPayout({
          ...validInput,
          senderItemId: "x".repeat(31),
        }),
      /Sender item ID/i
    );

    assert.equal(fetchCalls.length, 0);
  });

  it("rejects a PayPal response without a payout batch ID", async () => {
    mockResponse = {
      batch_header: {
        batch_status: "PENDING",
      },
    };

    await assert.rejects(
      () => createPayout(validInput),
      /did not return a payout batch ID/i
    );
  });

  it("retrieves payout status and item details", async () => {
    mockResponse = {
      batch_header: {
        payout_batch_id: "BATCH-123",
        batch_status: "SUCCESS",
        sender_batch_header: {
          sender_batch_id: validInput.senderBatchId,
        },
      },
      items: [
        {
          payout_item_id: "ITEM-123",
          transaction_status: "SUCCESS",
          payout_item: {
            receiver: validInput.receiverEmail,
            amount: {
              value: "12.50",
              currency: "USD",
            },
          },
        },
      ],
    };

    const result = await getPayoutStatus("BATCH-123");

    assert.equal(result.payoutBatchId, "BATCH-123");
    assert.equal(result.senderBatchId, validInput.senderBatchId);
    assert.equal(result.batchStatus, "SUCCESS");

    assert.equal(result.items.length, 1);

    assert.equal(result.items[0]?.payoutItemId, "ITEM-123");
    assert.equal(result.items[0]?.transactionStatus, "SUCCESS");
    assert.equal(result.items[0]?.receiver, validInput.receiverEmail);
    assert.equal(result.items[0]?.amount, "12.50");
    assert.equal(result.items[0]?.currency, "USD");
  });

  it("parses payout item error details", async () => {
  mockResponse = {
    batch_header: {
      payout_batch_id: "BATCH-123",
      batch_status: "DENIED",
    },
    items: [
      {
        transaction_status: "FAILED",
        errors: {
          name: "VALIDATION_ERROR",
          message: "Invalid recipient",
          details: [
            {
              field: "receiver",
              issue: "INVALID",
              description: "Recipient is invalid",
            },
          ],
        },
      },
    ],
  };

  const result = await getPayoutStatus("BATCH-123");

  assert.equal(result.items[0]?.error, "Invalid recipient");
  assert.equal(result.items[0]?.errorName, "VALIDATION_ERROR");
  assert.equal(
    result.items[0]?.errorDetails[0]?.field,
    "receiver"
  );
});

  it("rejects an empty payout batch ID", async () => {
    await assert.rejects(
      () => getPayoutStatus(""),
      /valid PayPal payout batch ID/i
    );

    assert.equal(fetchCalls.length, 0);
  });

  it("rejects payout batch IDs longer than 30 characters", async () => {
  await assert.rejects(
    () => getPayoutStatus("x".repeat(31)),
    /valid PayPal payout batch ID/i
  );

  assert.equal(fetchCalls.length, 0);
});

  it("rejects payout batch IDs containing path separators", async () => {
    await assert.rejects(
      () => getPayoutStatus("BATCH/123"),
      /valid PayPal payout batch ID/i
    );

    assert.equal(fetchCalls.length, 0);
  });
});
