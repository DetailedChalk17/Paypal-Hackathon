
import {
  createPayout,
  getPayoutStatus,
} from "./payouts.js";

const RECIPIENT_EMAIL = process.env.PAYPAL_RECIPIENT_EMAIL;

const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (!RECIPIENT_EMAIL) {
    throw new Error(
      "Missing PAYPAL_RECIPIENT_EMAIL in .env"
    );
  }

  // This is a one-time test. Do not blindly rerun
  // if the original request has an uncertain outcome.
  const senderBatchId = `P4-${Date.now()}`;
  const senderItemId = `P4ITEM-${Date.now()}`;

  console.log("=================================");
  console.log("ImpactLedger P4 Payout Test");
  console.log("=================================");
  console.log("Recipient:", RECIPIENT_EMAIL);
  console.log("Amount: $1.00 USD");
  console.log("Sender Batch ID:", senderBatchId);

  console.log("\nInitiating payout...");

  const payout = await createPayout({
    receiverEmail: RECIPIENT_EMAIL,
    amountCents: 100,
    senderBatchId,
    senderItemId,
  });

  console.log("\nPayout request accepted!");
  console.log("Batch ID:", payout.payoutBatchId);
  console.log("Initial status:", payout.status);

  console.log("\nPolling payout status...");

  const maxAttempts = 24;
  const interval = 5000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await delay(interval);

    const status = await getPayoutStatus(
      payout.payoutBatchId
    );

    console.log(`\nAttempt ${attempt}/${maxAttempts}`);
    console.log("Batch status:", status.batchStatus);

    for (const item of status.items) {
      console.log("Item status:", item.transactionStatus);

      if (item.error) {
        console.log("Item error:", item.error);
      }
    }

    const itemStatuses = status.items.map(
      (item) => item.transactionStatus
    );

    const terminalItemStatuses = [
      "SUCCESS",
      "FAILED",
      "UNCLAIMED",
      "RETURNED",
      "BLOCKED",
      "REFUNDED",
      "REVERSED",
    ];

    if (
    ["DENIED", "CANCELED"].includes(status.batchStatus) ||
    (
        status.batchStatus === "SUCCESS" &&
        itemStatuses.length > 0 &&
        itemStatuses.every((s) =>
          terminalItemStatuses.includes(s)
        )
    )
) {
      console.log("\nFinal payout status:");
      console.log(JSON.stringify(status, null, 2));
      return;
    }
  }

  console.log(
    "\nPolling limit reached. Payout outcome is still unresolved."
  );
  console.log(
    "Save the batch ID and investigate before retrying."
  );
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : String(error);

  console.error("\nPayout test failed:", message);
  process.exitCode = 1;
});
