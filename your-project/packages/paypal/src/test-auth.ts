import { getAccessToken } from "./client.js";
async function main() {
  await getAccessToken();

  console.log("PayPal Sandbox authentication successful!");
  console.log("Access token received and cached.");
  console.log("Token value has not been printed.");
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : String(error);
  console.error(" PayPal authentication failed:", message);
  process.exitCode = 1;
});
