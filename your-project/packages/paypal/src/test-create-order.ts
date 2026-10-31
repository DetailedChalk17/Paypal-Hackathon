import { randomUUID } from "node:crypto";
import { createOrder } from "./orders.js";

async function main() {
  const order = await createOrder({
    campaignId: "impactledger-test-campaign",
    amountCents: 500,
    requestId: randomUUID(),
  });

  console.log("\nPayPal Sandbox order created!");
  console.log("Order ID:", order.orderId);
  console.log("Status:", order.status);
  console.log("Approval URL:", order.approvalUrl);
}

main().catch((error: unknown) => {
  console.error(
    "Order creation failed:",
    error instanceof Error ? error.message : error
  );

  process.exitCode = 1;
});