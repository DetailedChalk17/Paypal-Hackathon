import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PayPalApiError,
  PayPalTransportError,
} from "./client.js";

import {
  verifyWebhookSignature,
  type PayPalWebhookHeaders,
} from "./webhooks.js";

const originalFetch = globalThis.fetch;

const originalEnv = {
  clientId: process.env.PAYPAL_CLIENT_ID,
  clientSecret: process.env.PAYPAL_CLIENT_SECRET,
  environment: process.env.PAYPAL_ENV,
  webhookId: process.env.PAYPAL_WEBHOOK_ID,
};

function restoreEnvironment() {
  const entries = [
    ["PAYPAL_CLIENT_ID", originalEnv.clientId],
    ["PAYPAL_CLIENT_SECRET", originalEnv.clientSecret],
    ["PAYPAL_ENV", originalEnv.environment],
    ["PAYPAL_WEBHOOK_ID", originalEnv.webhookId],
  ] as const;

  for (const [key, value] of entries) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const headers: PayPalWebhookHeaders = {
  transmissionId: "TEST-TRANSMISSION-ID",
  transmissionTime: "2026-11-11T04:00:00Z",
  transmissionSignature: "TEST-SIGNATURE",
  certUrl: "https://example.test/cert",
  authAlgo: "SHA256withRSA",
};

test("PayPal webhook signature verification", async (t) => {
  try {
    process.env.PAYPAL_CLIENT_ID = "test-client";
    process.env.PAYPAL_CLIENT_SECRET = "test-secret";
    process.env.PAYPAL_ENV = "sandbox";
    process.env.PAYPAL_WEBHOOK_ID = "TEST-WEBHOOK-ID";

    const event = {
      id: "WH-TEST-001",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "TEST-CAPTURE-ID",
        status: "COMPLETED",
      },
    };

    const rawEventBody = JSON.stringify(event, null, 2);

    // ------------------------------------------
    // TEST 1: Successful verification and request construction
    // ------------------------------------------

    await t.test(
      "Sends the correct verification request and accepts SUCCESS",
      async () => {
        let authenticationCalls = 0;
        let verificationCalls = 0;
        let observedRequestBody = "";
        let observedRequestHeaders: Headers | undefined;

        globalThis.fetch = async (input, init) => {
          const url = String(input);

          if (url.endsWith("/v1/oauth2/token")) {
            authenticationCalls++;

            return jsonResponse({
              access_token: "mock-access-token",
              token_type: "Bearer",
              expires_in: 3600,
            });
          }

          if (
            url.endsWith(
              "/v1/notifications/verify-webhook-signature"
            )
          ) {
            verificationCalls++;
            observedRequestBody = String(init?.body ?? "");
            observedRequestHeaders = new Headers(init?.headers);

            return jsonResponse({
              verification_status: "SUCCESS",
            });
          }

          throw new Error(`Unexpected PayPal URL: ${url}`);
        };

        const result = await verifyWebhookSignature(
          headers,
          rawEventBody
        );

        assert.equal(result, true);
        assert.equal(authenticationCalls, 1);
        assert.equal(verificationCalls, 1);

        assert.equal(
          observedRequestHeaders?.get("Authorization"),
          "Bearer mock-access-token"
        );

        assert.equal(
          observedRequestHeaders?.get("Content-Type"),
          "application/json"
        );

        const verificationBody = JSON.parse(observedRequestBody);

        assert.deepEqual(verificationBody, {
          transmission_id: headers.transmissionId,
          transmission_time: headers.transmissionTime,
          transmission_sig: headers.transmissionSignature,
          cert_url: headers.certUrl,
          auth_algo: headers.authAlgo,
          webhook_id: "TEST-WEBHOOK-ID",
          webhook_event: event,
        });

        // Ensure the original event JSON was embedded without reserializing it.
        assert.ok(observedRequestBody.includes(rawEventBody));
      }
    );

    // ------------------------------------------
    // TEST 2: PayPal rejects the signature
    // ------------------------------------------

    await t.test(
      "Returns false when PayPal responds with FAILURE",
      async () => {
        globalThis.fetch = async () =>
          jsonResponse({
            verification_status: "FAILURE",
          });

        const result = await verifyWebhookSignature(
          headers,
          rawEventBody
        );

        assert.equal(result, false);
      }
    );

    // ------------------------------------------
    // TEST 3: Missing webhook ID
    // ------------------------------------------

    await t.test(
      "Rejects missing PAYPAL_WEBHOOK_ID",
      async () => {
        delete process.env.PAYPAL_WEBHOOK_ID;

        let fetchCalls = 0;

        globalThis.fetch = async () => {
          fetchCalls++;
          return jsonResponse({});
        };

        await assert.rejects(
          verifyWebhookSignature(headers, rawEventBody),
          /Missing PAYPAL_WEBHOOK_ID/
        );

        assert.equal(fetchCalls, 0);

        process.env.PAYPAL_WEBHOOK_ID = "TEST-WEBHOOK-ID";
      }
    );

    // ------------------------------------------
    // TEST 4: Malformed event JSON
    // ------------------------------------------

    await t.test(
      "Rejects malformed webhook JSON",
      async () => {
        let fetchCalls = 0;

        globalThis.fetch = async () => {
          fetchCalls++;
          return jsonResponse({});
        };

        await assert.rejects(
          verifyWebhookSignature(headers, "{invalid-json"),
          SyntaxError
        );

        assert.equal(fetchCalls, 0);
      }
    );

    // ------------------------------------------
    // TEST 5: PayPal API failure
    // ------------------------------------------

    await t.test(
      "Propagates PayPal API verification errors",
      async () => {
        globalThis.fetch = async () =>
          jsonResponse(
            {
              name: "INVALID_REQUEST",
              message: "Webhook verification failed",
              debug_id: "MOCK-VERIFY-ERROR",
            },
            400
          );

        await assert.rejects(
          verifyWebhookSignature(headers, rawEventBody),
          (error: unknown) => {
            assert.ok(error instanceof PayPalApiError);
            assert.equal(error.status, 400);
            assert.equal(error.providerName, "INVALID_REQUEST");
            assert.equal(error.debugId, "MOCK-VERIFY-ERROR");
            return true;
          }
        );
      }
    );

    // ------------------------------------------
    // TEST 6: Network/transport failure
    // ------------------------------------------

    await t.test(
      "Classifies verification transport failures",
      async () => {
        globalThis.fetch = async () => {
          throw new Error("Mock network failure");
        };

        await assert.rejects(
          verifyWebhookSignature(headers, rawEventBody),
          (error: unknown) => {
            assert.ok(error instanceof PayPalTransportError);
            assert.equal(error.stage, "request");
            assert.equal(error.timedOut, false);
            return true;
          }
        );
      }
    );

    console.log("All PayPal webhook verification tests completed.");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment();
  }
});
