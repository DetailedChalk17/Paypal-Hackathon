
import { paypalRequest } from "./client.js";

// PayPal payout response types
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

// Input required to create a payout
type CreatePayoutInput = {
  receiverEmail: string;
  amountCents: number;
  senderBatchId: string;
  senderItemId: string;
};

// Convert cents to PayPal decimal format.
function centsToAmount(amountCents: number): string {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new Error("Payout amount must be positive integer cents.");
  }

  return (amountCents / 100).toFixed(2);
}

// STEP 1: Create a payout.
export async function createPayout(input: CreatePayoutInput) {
  const {
    receiverEmail,
    amountCents,
    senderBatchId,
    senderItemId,
  } = input;

  if (!receiverEmail.trim()) {
    throw new Error("Recipient email is required.");
  }

  if (receiverEmail.length > 127) {
    throw new Error("Recipient email is too long.");
  }

  if (!senderBatchId.trim() || senderBatchId.length > 30) {
    throw new Error("Sender batch ID must contain 1-30 characters.");
  }

  if (!senderItemId.trim() || senderItemId.length > 30) {
    throw new Error("Sender item ID must contain 1-30 characters.");
  }

  const requestBody = {
    sender_batch_header: {
      sender_batch_id: senderBatchId,
      email_subject: "You have received an ImpactLedger payout!",
      email_message: "This is a $1 ImpactLedger Sandbox payout test.",
    },
    items: [
      {
        recipient_type: "EMAIL",
        receiver: receiverEmail,
        amount: {
          value: centsToAmount(amountCents),
          currency: "USD",
        },
        sender_item_id: senderItemId,
        note: "ImpactLedger P4 Sandbox payout test",
      },
    ],
  };

  const response =
    await paypalRequest<PayPalPayoutBatchResponse>(
      "/v1/payments/payouts",
      {
        method: "POST",
        body: requestBody,
        requestId: senderBatchId,
      }
    );

  const payoutBatchId =
    response.batch_header?.payout_batch_id;

  if (!payoutBatchId) {
    throw new Error("PayPal did not return a payout batch ID.");
  }

  return {
    payoutBatchId,
    senderBatchId,
    status: response.batch_header?.batch_status ?? "UNKNOWN",
  };
}

// STEP 2: Retrieve the current payout status.
export async function getPayoutStatus(payoutBatchId: string) {
  if (!payoutBatchId.trim()) {
    throw new Error("Payout batch ID is required.");
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
      response.batch_header?.payout_batch_id ?? payoutBatchId,
    batchStatus:
      response.batch_header?.batch_status ?? "UNKNOWN",
    items: (response.items ?? []).map((item) => ({
      payoutItemId: item.payout_item_id,
      transactionStatus: item.transaction_status ?? "UNKNOWN",
      receiver: item.payout_item?.receiver,
      amount: item.payout_item?.amount?.value,
      currency: item.payout_item?.amount?.currency,
      error: item.errors?.message,
    })),
  };
}
