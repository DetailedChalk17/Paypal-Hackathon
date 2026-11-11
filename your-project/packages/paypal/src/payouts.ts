
import { paypalRequest } from "./client.js";

// ==========================================
// PAYPAL RESPONSE TYPES
// ==========================================

type PayPalPayoutBatchResponse = {
  batch_header?: {
    payout_batch_id?: string;
    batch_status?: string;
    sender_batch_header?: {
      sender_batch_id?: string;
    };
  };
  links?: Array<{
    rel?: string;
    href?: string;
  }>;
};

type PayPalPayoutItem = {
  payout_item_id?: string;
  transaction_status?: string;
  payout_item?: {
    recipient_type?: string;
    receiver?: string;
    amount?: {
      value?: string;
      currency?: string;
    };
  };
  errors?: {
    name?: string;
    message?: string;
    details?: Array<{
      field?: string;
      issue?: string;
      description?: string;
    }>;
  };
};

type PayPalPayoutStatusResponse = {
  batch_header?: {
    payout_batch_id?: string;
    batch_status?: string;
    sender_batch_header?: {
      sender_batch_id?: string;
    };
  };
  items?: PayPalPayoutItem[];
};

// ==========================================
// INPUT TYPES
// ==========================================

export type CreatePayoutInput = {
  receiverEmail: string;
  amountCents: number;
  senderBatchId: string;
  senderItemId: string;
};

// ==========================================
// VALIDATION HELPERS
// ==========================================

const SUPPORTED_CURRENCY = "USD";

function validateEmail(email: string): void {
  if (
    !email ||
    email !== email.trim() ||
    email.length > 127 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new Error("A valid recipient email is required.");
  }
}

function validateIdentifier(
  value: string,
  name: string
): void {
  if (
    !value ||
    value.length > 30 ||
    /\s/.test(value)
  ) {
    throw new Error(
      `${name} must contain 1-30 non-whitespace characters.`
    );
  }
}

// Convert integer cents to PayPal decimal money format.
function centsToAmount(amountCents: number): string {
  if (
    !Number.isSafeInteger(amountCents) ||
    amountCents <= 0
  ) {
    throw new Error(
      "Payout amount must be positive integer cents."
    );
  }

  return (amountCents / 100).toFixed(2);
}

// ==========================================
// CREATE PAYOUT
// ==========================================

export async function createPayout(
  input: CreatePayoutInput
) {
  const {
    receiverEmail,
    amountCents,
    senderBatchId,
    senderItemId,
  } = input;

  validateEmail(receiverEmail);

  validateIdentifier(
    senderBatchId,
    "Sender batch ID"
  );

  validateIdentifier(
    senderItemId,
    "Sender item ID"
  );

  const amount = centsToAmount(amountCents);

  const requestBody = {
    sender_batch_header: {
      sender_batch_id: senderBatchId,
      email_subject: "You have received an ImpactLedger payout",
      email_message:
        "Your approved ImpactLedger milestone payout is being processed.",
    },
    items: [
      {
        recipient_type: "EMAIL",
        receiver: receiverEmail,
        amount: {
          value: amount,
          currency: SUPPORTED_CURRENCY,
        },
        sender_item_id: senderItemId,
        note: "ImpactLedger approved milestone payout",
      },
    ],
  };

  const response =
    await paypalRequest<PayPalPayoutBatchResponse>(
      "/v1/payments/payouts",
      {
        method: "POST",
        body: requestBody,

        // Preserve the same request ID when retrying
        // the same logical payout submission.
        requestId: senderBatchId,
      }
    );

  const payoutBatchId =
    response.batch_header?.payout_batch_id;

  if (!payoutBatchId) {
    throw new Error(
      "PayPal did not return a payout batch ID."
    );
  }

  return {
    payoutBatchId,
    senderBatchId,
    senderItemId,
    amount,
    currency: SUPPORTED_CURRENCY,
    status:
      response.batch_header?.batch_status ?? "UNKNOWN",
  };
}

// ==========================================
// GET PAYOUT STATUS
// ==========================================

export async function getPayoutStatus(
  payoutBatchId: string
) {
  if (
    !payoutBatchId ||
    payoutBatchId !== payoutBatchId.trim() ||
    payoutBatchId.length > 30 ||
    /\s/.test(payoutBatchId) ||
    /[\/\\?#]/.test(payoutBatchId)
  ) {
    throw new Error(
      "A valid PayPal payout batch ID is required."
    );
  }

  const response =
    await paypalRequest<PayPalPayoutStatusResponse>(
      `/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}`,
      {
        method: "GET",
      }
    );

  return {
    payoutBatchId:
      response.batch_header?.payout_batch_id ??
      payoutBatchId,

    senderBatchId:
      response.batch_header?.sender_batch_header
        ?.sender_batch_id,

    batchStatus:
      response.batch_header?.batch_status ?? "UNKNOWN",

    items: (response.items ?? []).map((item) => ({
      payoutItemId: item.payout_item_id,

      transactionStatus:
        item.transaction_status ?? "UNKNOWN",

      receiver: item.payout_item?.receiver,

      amount: item.payout_item?.amount?.value,

      currency: item.payout_item?.amount?.currency,

      error: item.errors?.message,

      errorName: item.errors?.name,

      errorDetails: item.errors?.details ?? [],
    })),
  };
}
