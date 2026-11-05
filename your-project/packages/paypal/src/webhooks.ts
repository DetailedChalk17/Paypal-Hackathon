import { paypalRequest } from "./client.js";

type PayPalVerificationResponse = {
  verification_status: "SUCCESS" | "FAILURE";
};

export type PayPalWebhookHeaders = {
  transmissionId: string;
  transmissionTime: string;
  transmissionSignature: string;
  certUrl: string;
  authAlgo: string;
};

export async function verifyWebhookSignature(
  headers: PayPalWebhookHeaders,
  rawEventBody: string
): Promise<boolean> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;

  if (!webhookId) {
    throw new Error("Missing PAYPAL_WEBHOOK_ID");
  }

  const event: unknown = JSON.parse(rawEventBody);

  if (
    typeof event !== "object" ||
    event === null ||
    Array.isArray(event)
  ) {
    throw new Error("Invalid PayPal webhook event");
  }

  const body = `{
    "transmission_id": ${JSON.stringify(headers.transmissionId)},
    "transmission_time": ${JSON.stringify(headers.transmissionTime)},
    "transmission_sig": ${JSON.stringify(headers.transmissionSignature)},
    "cert_url": ${JSON.stringify(headers.certUrl)},
    "auth_algo": ${JSON.stringify(headers.authAlgo)},
    "webhook_id": ${JSON.stringify(webhookId)},
    "webhook_event": ${rawEventBody}
  }`;

  const result =
    await paypalRequest<PayPalVerificationResponse>(
      "/v1/notifications/verify-webhook-signature",
      {
        method: "POST",
        rawBody: body,
      }
    );

  return result.verification_status === "SUCCESS";
}