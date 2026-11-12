const PAYPAL_API_BASE_URL = "https://api-m.sandbox.paypal.com";
const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

type PayPalTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
};

type PayPalRequestOptions = {
  method: "GET" | "POST";
  body?: unknown;
  requestId?: string;
  rawBody?: string;
};

export type PayPalErrorDetail = {
  field?: string;
  issue?: string;
  description?: string;
};

export class PayPalConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayPalConfigurationError";
  }
}

export class PayPalAuthenticationError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly providerName?: string,
    public readonly debugId?: string
  ) {
    super(message);
    this.name = "PayPalAuthenticationError";
  }
}

export class PayPalApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly providerName?: string,
    public readonly debugId?: string,
    public readonly details: PayPalErrorDetail[] = []
  ) {
    super(message);
    this.name = "PayPalApiError";
  }
}

export class PayPalTransportError extends Error {
  constructor(
    message: string,
    public readonly stage: "authentication" | "request",
    public readonly timedOut: boolean
  ) {
    super(message);
    this.name = "PayPalTransportError";
  }
}

type PayPalErrorResponse = {
  name?: string;
  message?: string;
  debug_id?: string;
  details?: PayPalErrorDetail[];
  error_description?: string;
};

let cachedToken: {
  value: string;
  expiresAt: number;
} | null = null;

// Concurrent callers share one token refresh request.
let tokenRefreshPromise: Promise<string> | null = null;

function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value?.trim()) {
    throw new PayPalConfigurationError(
      `Missing environment variable: ${name}`
    );
  }

  return value;
}

function parseErrorResponse(data: unknown): PayPalErrorResponse {
  if (typeof data !== "object" || data === null) {
    return {};
  }

  return data as PayPalErrorResponse;
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "TimeoutError"
  );
}

// Create a transport error based on the provided error and stage.
function createTransportError(
  error: unknown,
  stage: "authentication" | "request"
): PayPalTransportError {
  const timedOut = isTimeoutError(error);

  return new PayPalTransportError(
    timedOut
      ? `PayPal ${stage} request timed out.`
      : `PayPal ${stage} request failed due to a network or transport error.`,
    stage,
    timedOut
  );
}

// Obtain a Sandbox access token.
export async function getAccessToken(): Promise<string> {
  const clientId = getRequiredEnv("PAYPAL_CLIENT_ID");
  const clientSecret = getRequiredEnv("PAYPAL_CLIENT_SECRET");
  const environment =
    process.env.PAYPAL_ENV ??
    process.env.PAYPAL_ENVIRONMENT ??
    getRequiredEnv("PAYPAL_ENV");

  if (environment !== "sandbox") {
    throw new PayPalConfigurationError(
      "This integration currently supports Sandbox only."
    );
  }

  if (
    cachedToken &&
    cachedToken.expiresAt > Date.now() + TOKEN_EXPIRY_BUFFER_MS
  ) {
    return cachedToken.value;
  }

  if (tokenRefreshPromise) {
    return tokenRefreshPromise;
  }

  tokenRefreshPromise = (async () => {
    const credentials = Buffer.from(
      `${clientId}:${clientSecret}`
    ).toString("base64");

    let response: Response;

    try {
      response = await fetch(
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
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }
      );
    } catch (error) {
      throw createTransportError(error, "authentication");
    }

    const data: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const providerError = parseErrorResponse(data);

      throw new PayPalAuthenticationError(
        providerError.error_description ??
          providerError.message ??
          `PayPal authentication failed (${response.status}).`,
        response.status,
        providerError.name,
        providerError.debug_id
      );
    }

    if (
      typeof data !== "object" ||
      data === null ||
      !("access_token" in data) ||
      typeof data.access_token !== "string" ||
      !data.access_token.trim() ||
      !("expires_in" in data) ||
      typeof data.expires_in !== "number" ||
      data.expires_in <= 0
    ) {
      throw new PayPalAuthenticationError(
        "PayPal returned an invalid token response."
      );
    }

    const tokenResponse = data as PayPalTokenResponse;

    cachedToken = {
      value: tokenResponse.access_token,
      expiresAt: Date.now() + tokenResponse.expires_in * 1000,
    };

    return cachedToken.value;
  })();

  try {
    return await tokenRefreshPromise;
  } finally {
    tokenRefreshPromise = null;
  }
}

// Reusable authenticated PayPal API request.
export async function paypalRequest<T>(
  path: string,
  options: PayPalRequestOptions
): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new PayPalConfigurationError(
      "Invalid PayPal API path."
    );
  }

  const accessToken = await getAccessToken();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };

  if (
    options.body !== undefined ||
    options.rawBody !== undefined
  ) {
    headers["Content-Type"] = "application/json";
  }

  if (options.requestId) {
    headers["PayPal-Request-Id"] = options.requestId;
  }

  let response: Response;

  try {
    response = await fetch(
      `${PAYPAL_API_BASE_URL}${path}`,
      {
        method: options.method,
        headers,
        body:
          options.rawBody ??
          (options.body !== undefined
            ? JSON.stringify(options.body)
            : undefined),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
  } catch (error) {
    throw createTransportError(error, "request");
  }

  const data: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const providerError = parseErrorResponse(data);

    throw new PayPalApiError(
      providerError.message ??
        `PayPal API request failed (${response.status}).`,
      response.status,
      providerError.name,
      providerError.debug_id,
      Array.isArray(providerError.details)
        ? providerError.details
        : []
    );
  }

  if (data === null) {
    throw new PayPalApiError(
      "PayPal returned an empty or invalid response.",
      response.status
    );
  }

  return data as T;
}
