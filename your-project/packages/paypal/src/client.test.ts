
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getAccessToken,
  paypalRequest,
  PayPalConfigurationError,
  PayPalAuthenticationError,
  PayPalApiError,
  PayPalTransportError,
} from "./client.js";

const originalFetch = globalThis.fetch;

const originalEnv = {
  clientId: process.env.PAYPAL_CLIENT_ID,
  clientSecret: process.env.PAYPAL_CLIENT_SECRET,
  environment: process.env.PAYPAL_ENV,
};

function restoreEnvironment() {
  if (originalEnv.clientId === undefined) {
    delete process.env.PAYPAL_CLIENT_ID;
  } else {
    process.env.PAYPAL_CLIENT_ID = originalEnv.clientId;
  }

  if (originalEnv.clientSecret === undefined) {
    delete process.env.PAYPAL_CLIENT_SECRET;
  } else {
    process.env.PAYPAL_CLIENT_SECRET = originalEnv.clientSecret;
  }

  if (originalEnv.environment === undefined) {
    delete process.env.PAYPAL_ENV;
  } else {
    process.env.PAYPAL_ENV = originalEnv.environment;
  }
}

function mockFetch(
  implementation: typeof fetch
) {
  globalThis.fetch = implementation;
}

function jsonResponse(
  data: unknown,
  status = 200
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

test("PayPal client automated tests", async (t) => {
  try {
    // ------------------------------------------
    // TEST 1: Missing credentials
    // ------------------------------------------

    await t.test("Rejects missing credentials", async () => {
      delete process.env.PAYPAL_CLIENT_ID;
      process.env.PAYPAL_CLIENT_SECRET = "test-secret";
      process.env.PAYPAL_ENV = "sandbox";

      await assert.rejects(
        getAccessToken(),
        PayPalConfigurationError
      );
    });

    // ------------------------------------------
    // TEST 2: Sandbox-only enforcement
    // ------------------------------------------

    await t.test("Rejects unsupported environment", async () => {
      process.env.PAYPAL_CLIENT_ID = "test-client";
      process.env.PAYPAL_CLIENT_SECRET = "test-secret";
      process.env.PAYPAL_ENV = "live";

      await assert.rejects(
        getAccessToken(),
        PayPalConfigurationError
      );
    });

    // ------------------------------------------
    // TEST 3: Authentication rejection
    // ------------------------------------------

    await t.test("Preserves authentication errors", async () => {
      process.env.PAYPAL_ENV = "sandbox";

      mockFetch(async () =>
        jsonResponse(
          {
            error: "invalid_client",
            error_description: "Invalid credentials",
          },
          401
        )
      );

      await assert.rejects(
        getAccessToken(),
        (error: unknown) => {
          assert.ok(error instanceof PayPalAuthenticationError);
          assert.equal(error.status, 401);
          assert.match(error.message, /Invalid credentials/);
          return true;
        }
      );
    });

    // ------------------------------------------
    // TEST 4: Authentication timeout
    // ------------------------------------------

    await t.test("Classifies authentication timeout", async () => {
      mockFetch(async () => {
        throw new DOMException(
          "Request timed out",
          "TimeoutError"
        );
      });

      await assert.rejects(
        getAccessToken(),
        (error: unknown) => {
          assert.ok(error instanceof PayPalTransportError);
          assert.equal(error.stage, "authentication");
          assert.equal(error.timedOut, true);
          return true;
        }
      );
    });


    // ------------------------------------------
    // TEST 4.5: Reject empty access token
    // ------------------------------------------

    await t.test("Rejects empty access tokens", async () => {
      mockFetch(async () =>
        jsonResponse({
          access_token: "   ",
          token_type: "Bearer",
          expires_in: 3600,
        })
      );

      await assert.rejects(
        getAccessToken(),
        PayPalAuthenticationError
      );
    });

    // ------------------------------------------
    // TEST 5: Concurrent token refresh
    // ------------------------------------------

    await t.test("Shares concurrent token refresh", async () => {
      let authenticationCalls = 0;

      let resolveAuthentication!: (
        response: Response
      ) => void;

      mockFetch(async () => {
        authenticationCalls++;

        return new Promise<Response>((resolve) => {
          resolveAuthentication = resolve;
        });
      });

      const firstRequest = getAccessToken();
      const secondRequest = getAccessToken();
      const thirdRequest = getAccessToken();

      assert.equal(authenticationCalls, 1);

      resolveAuthentication(
        jsonResponse({
          access_token: "mock-access-token",
          token_type: "Bearer",
          expires_in: 3600,
        })
      );

      const tokens = await Promise.all([
        firstRequest,
        secondRequest,
        thirdRequest,
      ]);

      assert.deepEqual(tokens, [
        "mock-access-token",
        "mock-access-token",
        "mock-access-token",
      ]);

      assert.equal(authenticationCalls, 1);
    });

    // ------------------------------------------
    // TEST 6: Token cache
    // ------------------------------------------

    await t.test("Reuses cached access token", async () => {
      let authenticationCalls = 0;

      mockFetch(async () => {
        authenticationCalls++;

        return jsonResponse({
          access_token: "unexpected-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      });

      const token = await getAccessToken();

      assert.equal(token, "mock-access-token");
      assert.equal(authenticationCalls, 0);
    });

    // ------------------------------------------
    // TEST 7: Structured API error
    // ------------------------------------------

    await t.test("Preserves PayPal API error details", async () => {
      mockFetch(async () =>
        jsonResponse(
          {
            name: "VALIDATION_ERROR",
            message: "Invalid request",
            debug_id: "MOCK-DEBUG-ID",
            details: [
              {
                field: "receiver",
                issue: "INVALID_EMAIL_FORMAT",
                description: "Invalid recipient email",
              },
            ],
          },
          422
        )
      );

      await assert.rejects(
        paypalRequest("/v1/payments/payouts", {
          method: "POST",
          body: {},
        }),
        (error: unknown) => {
          assert.ok(error instanceof PayPalApiError);
          assert.equal(error.status, 422);
          assert.equal(error.providerName, "VALIDATION_ERROR");
          assert.equal(error.debugId, "MOCK-DEBUG-ID");
          assert.equal(error.details[0]?.field, "receiver");
          return true;
        }
      );
    });

    // ------------------------------------------
    // TEST 8: Request timeout
    // ------------------------------------------

    await t.test("Classifies API request timeout", async () => {
      mockFetch(async () => {
        throw new DOMException(
          "Request timed out",
          "TimeoutError"
        );
      });

      await assert.rejects(
        paypalRequest("/v1/payments/payouts", {
          method: "POST",
          body: {},
        }),
        (error: unknown) => {
          assert.ok(error instanceof PayPalTransportError);
          assert.equal(error.stage, "request");
          assert.equal(error.timedOut, true);
          return true;
        }
      );
    });

    // ------------------------------------------
    // TEST 9: Request ID header
    // ------------------------------------------

    await t.test("Sends PayPal request ID", async () => {
      let observedRequestId: string | null = null;

      mockFetch(async (_input, init) => {
        const headers = new Headers(init?.headers);

        observedRequestId = headers.get(
          "PayPal-Request-Id"
        );

        return jsonResponse({
          success: true,
        });
      });

      const result = await paypalRequest<{
        success: boolean;
      }>("/v1/payments/payouts", {
        method: "POST",
        body: {},
        requestId: "stable-test-request-id",
      });

      assert.equal(result.success, true);
      assert.equal(
        observedRequestId,
        "stable-test-request-id"
      );
    });

    // ------------------------------------------
    // TEST 10: Invalid API path
    // ------------------------------------------

    await t.test("Rejects invalid API paths", async () => {
      await assert.rejects(
        paypalRequest("//malicious.example", {
          method: "GET",
        }),
        PayPalConfigurationError
      );
    });

    console.log("All PayPal client tests completed.");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment();
  }
});
