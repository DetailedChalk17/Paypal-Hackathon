const PAYPAL_API_BASE_URL = "https://api-m.sandbox.paypal.com";

type PayPalTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
};

type PayPalRequestOptions = {
  method: "GET" | "POST";
  body?: unknown;
  requestId?: string;
};

// Cache the access token so we don't authenticate for every API request.
let cachedToken: {
  value: string;
  expiresAt: number;
} | null = null;

function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

// STEP 1: Get a PayPal access token.
export async function getAccessToken(): Promise<string> {
  const clientId = getRequiredEnv("PAYPAL_CLIENT_ID");
  const clientSecret = getRequiredEnv("PAYPAL_CLIENT_SECRET");
  const environment = getRequiredEnv("PAYPAL_ENV");

  if (environment !== "sandbox") {
    throw new Error("This integration currently supports Sandbox only.");
  }

  // Reuse the cached token if it hasn't nearly expired.
  if (
    cachedToken &&
    cachedToken.expiresAt > Date.now() + 60_000
  ) {
    return cachedToken.value;
  }

  // PayPal expects Client ID and Secret using HTTP Basic Auth.
  const credentials = Buffer.from(
    `${clientId}:${clientSecret}`
  ).toString("base64");

  const response = await fetch(
    `${PAYPAL_API_BASE_URL}/v1/oauth2/token`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
      }),
      signal: AbortSignal.timeout(15_000),
    }
  );

  const data: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const details =
      typeof data === "object" &&
      data !== null &&
      "error_description" in data &&
      typeof data.error_description === "string"
        ? data.error_description
        : response.statusText;

    throw new Error(
      `PayPal authentication failed (${response.status}): ${details}`
    );
  }

  if (
    typeof data !== "object" ||
    data === null ||
    !("access_token" in data) ||
    typeof data.access_token !== "string" ||
    !("expires_in" in data) ||
    typeof data.expires_in !== "number"
  ) {
    throw new Error("PayPal returned an invalid token response.");
  }

  const tokenResponse = data as PayPalTokenResponse;

  cachedToken = {
    value: tokenResponse.access_token,
    expiresAt: Date.now() + tokenResponse.expires_in * 1000,
  };

  return cachedToken.value;
}

// STEP 2: Reusable helper for making authenticated PayPal API requests.
export async function paypalRequest<T>(
  path: string,
  options: PayPalRequestOptions
): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Invalid PayPal API path.");
  }

  const accessToken = await getAccessToken();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  // Used to help prevent duplicate operations when retrying requests.
  if (options.requestId) {
    headers["PayPal-Request-Id"] = options.requestId;
  }

  const response = await fetch(
    `${PAYPAL_API_BASE_URL}${path}`,
    {
      method: options.method,
      headers,
      body:
        options.body !== undefined
          ? JSON.stringify(options.body)
          : undefined,
      signal: AbortSignal.timeout(15_000),
    }
  );

  const data: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      typeof data === "object" &&
      data !== null &&
      "message" in data &&
      typeof data.message === "string"
        ? data.message
        : response.statusText;

    throw new Error(
      `PayPal API error (${response.status}): ${message}`
    );
  }

  if (data === null) {
    throw new Error("PayPal returned an empty or invalid response.");
  }

  return data as T;
}