
import { refundCapture } from "./orders.js";

const CAPTURE_ID = "37H372910M252742V";
const REQUEST_ID = "P6-SANDBOX-REFUND-001";

async function main() {
  console.log("Starting P6 PayPal Sandbox refund...");
  console.log("Capture ID:", CAPTURE_ID);
  console.log("Refund type: FULL");
  console.log("Amount: $5.00 USD");

  const result = await refundCapture({
    captureId: CAPTURE_ID,
    requestId: REQUEST_ID,
    customId: REQUEST_ID,
    noteToPayer: "ImpactLedger P6 Sandbox refund test",
  });

  console.log("\nPayPal refund response:");
  console.log("Refund ID:", result.refundId);
  console.log("Capture ID:", result.captureId);
  console.log("Status:", result.status);
  console.log("Custom ID:", result.customId);
}

main().catch((error: unknown) => {
  console.error(
    "\nSandbox refund failed:",
    error instanceof Error ? error.message : error
  );

  process.exitCode = 1;
});
