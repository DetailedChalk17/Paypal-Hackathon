
export async function sendMockPayout(input: {
  milestoneId: string;
  amountCents: number;
}) {
  // Simulate a successful PayPal payout.
  return {
    success: true,
    senderBatchId: `MOCK-${input.milestoneId}-${Date.now()}`,
    amountCents: input.amountCents,
    message: "Mock payout successful",
  };
}
