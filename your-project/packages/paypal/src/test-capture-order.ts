import { captureOrder } from "./orders.js";

async function main() {
  const orderId = process.argv[2];

  if (!orderId) {
    throw new Error("Please provide the PayPal Order ID.");
  }

  const result = await captureOrder({
    orderId,
    expectedAmountCents: 500,
    requestId: `cap-${orderId}`,
  });

  console.log("\nPayPal Sandbox capture result!");
  console.log("Order ID:", result.orderId);
  console.log("Order Status:", result.orderStatus);
  console.log("Capture ID:", result.captureId);
  console.log("Capture Status:", result.captureStatus);
  console.log("Amount:", result.amountCents / 100, result.currencyCode);
}

main().catch((error: unknown) => {
  console.error(
    "Capture failed:",
    error instanceof Error ? error.message : error
  );

  process.exitCode = 1;
});