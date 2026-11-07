import { paypalRequest } from "./client.js";

// PayPal response types
type PayPalOrderResponse = {
  id: string;
  status: string;
  links?: Array<{
    rel?: string;
    href?: string;
  }>;
};

type PayPalCapture = {
  id: string;
  status: string;
  amount: {
    currency_code: string;
    value: string;
  };
};

type PayPalCaptureOrderResponse = {
  id: string;
  status: string;
  purchase_units?: Array<{
    payments?: {
      captures?: PayPalCapture[];
    };
  }>;
};

// Input required to create a donation order
type CreateOrderInput = {
  campaignId: string;
  amountCents: number;
  requestId: string;
  returnUrl?: string;
  cancelUrl?: string;
};

// Input required to capture a donation order
type CaptureOrderInput = {
  orderId: string;
  expectedAmountCents: number;
  requestId: string;
};

// Convert cents into PayPal's decimal amount format.
// Example: 500 cents becomes "5.00".
function centsToAmount(amountCents: number): string {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new Error("Donation amount must be a positive number of cents.");
  }

  return (amountCents / 100).toFixed(2);
}

// Convert PayPal's decimal amount back into cents.
function amountToCents(value: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);

  if (!match) {
    throw new Error("PayPal returned an invalid payment amount.");
  }

  const cents =
    Number(match[1]) * 100 +
    Number((match[2] ?? "").padEnd(2, "0"));

  if (!Number.isSafeInteger(cents)) {
    throw new Error("PayPal returned an invalid payment amount.");
  }

  return cents;
}

// STEP 1: Create a donation order.
export async function createOrder(input: CreateOrderInput) {
  const { campaignId, amountCents, requestId } = input;
  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:5173";
  const returnUrl =
    input.returnUrl ?? new URL("/paypal/return", frontendUrl).toString();
  const cancelUrl =
    input.cancelUrl ?? new URL("/paypal/cancel", frontendUrl).toString();

  if (!campaignId.trim() || campaignId.length > 127) {
    throw new Error("Invalid campaign ID.");
  }

  if (!requestId.trim()) {
    throw new Error("An idempotency request ID is required.");
  }

  const response = await paypalRequest<PayPalOrderResponse>(
    "/v2/checkout/orders",
    {
      method: "POST",
      requestId,
      body: {
  intent: "CAPTURE",
  purchase_units: [
    {
      custom_id: campaignId,
      amount: {
        currency_code: "USD",
        value: centsToAmount(amountCents),
      },
    },
  ],
  payment_source: {
    paypal: {
      experience_context: {
        brand_name: "ImpactLedger",
        user_action: "PAY_NOW",
        shipping_preference: "NO_SHIPPING",
        return_url: returnUrl,
        cancel_url: cancelUrl,
      },
    },
  },
},
    }
  );

  if (!response.id) {
    throw new Error("PayPal did not return an order ID.");
  }

  const approvalLink = response.links?.find(
    (link) => link.rel === "approve" || link.rel === "payer-action"
  );

  return {
    orderId: response.id,
    status: response.status,
    approvalUrl: approvalLink?.href ?? null,
  };
}

// STEP 2: Capture an order after the donor approves it.
export async function captureOrder(input: CaptureOrderInput) {
  const { orderId, expectedAmountCents, requestId } = input;

  if (!orderId.trim()) {
    throw new Error("Order ID is required.");
  }

  if (!requestId.trim()) {
    throw new Error("An idempotency request ID is required.");
  }

  const response =
    await paypalRequest<PayPalCaptureOrderResponse>(
      `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      {
        method: "POST",
        requestId,
        body: {},
      }
    );

  if (response.id !== orderId) {
    throw new Error("PayPal returned an unexpected order ID.");
  }

  // We create only one purchase unit for each donation.
  const captures =
    response.purchase_units?.[0]?.payments?.captures ?? [];

  if (captures.length !== 1) {
    throw new Error("Expected exactly one payment capture from PayPal.");
  }

  const capture = captures[0];

  if (!capture.id) {
    throw new Error("PayPal did not return a capture ID.");
  }

  if (capture.amount.currency_code !== "USD") {
    throw new Error("Unexpected payment currency.");
  }

  const actualAmountCents = amountToCents(capture.amount.value);

  if (actualAmountCents !== expectedAmountCents) {
    throw new Error("Captured amount does not match the expected donation.");
  }

  return {
    orderId: response.id,
    orderStatus: response.status,
    captureId: capture.id,
    captureStatus: capture.status,
    amountCents: actualAmountCents,
    currencyCode: capture.amount.currency_code,
  };
}