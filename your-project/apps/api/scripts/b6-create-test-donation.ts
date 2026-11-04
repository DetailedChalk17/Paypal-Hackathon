
import { prisma } from "../src/lib/prisma";
import { appendEvent } from "../src/services/ledger.service";

// ==========================================
// LOCAL TEST DATA ONLY
// No PayPal API calls are made.
// ==========================================

const DONATION_ID =
  "b6000000-0000-4000-8000-000000000001";

const DONOR_ID =
  "10000000-0000-4000-8000-000000000001";

const CAMPAIGN_ID =
  "30000000-0000-4000-8000-000000000001";

const AMOUNT_CENTS = 50000;

const EVENT_TYPE = "b6_test_donation_completed";

async function main() {
  // Safety: only allow the local impactledger database.
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is missing.");
  }

  const parsedUrl = new URL(databaseUrl);
  const databaseName = parsedUrl.pathname.replace(/^\/+/, "");

  if (
    !["localhost", "127.0.0.1"].includes(parsedUrl.hostname) ||
    databaseName !== "impactledger"
  ) {
    throw new Error(
      "Safety check failed. This script only runs against local impactledger."
    );
  }

  // Verify donor.
  const donor = await prisma.user.findUnique({
    where: { id: DONOR_ID },
  });

  if (!donor || donor.role !== "donor") {
    throw new Error("Expected demo donor was not found.");
  }

  // Verify campaign and organization.
  const campaign = await prisma.campaign.findUnique({
    where: { id: CAMPAIGN_ID },
    include: {
      organization: true,
      milestones: true,
    },
  });

  if (!campaign) {
    throw new Error("Expected test campaign was not found.");
  }

  if (campaign.organizationId !==
      "20000000-0000-4000-8000-000000000001") {
    throw new Error("Unexpected campaign organization.");
  }

  // Check whether the test donation already exists.
  let donation = await prisma.donation.findUnique({
    where: { id: DONATION_ID },
  });

  if (donation) {
    if (
      donation.donorId !== DONOR_ID ||
      donation.campaignId !== CAMPAIGN_ID ||
      donation.amountCents !== AMOUNT_CENTS ||
      donation.status !== "completed"
    ) {
      throw new Error(
        "Test donation ID exists with unexpected data."
      );
    }

    console.log("Test donation already exists.");
  } else {
    donation = await prisma.donation.create({
      data: {
        id: DONATION_ID,
        donorId: DONOR_ID,
        campaignId: CAMPAIGN_ID,
        amountCents: AMOUNT_CENTS,
        status: "completed",

        // No PayPal order or capture IDs.
        // This is synthetic local test data.
      },
    });

    console.log("Test donation created.");
  }

  // Add one ledger event if it does not already exist.
  const existingEvent = await prisma.ledgerEvent.findFirst({
    where: {
      entityId: DONATION_ID,
      type: EVENT_TYPE,
    },
  });

  if (!existingEvent) {
    await appendEvent(EVENT_TYPE, DONATION_ID, {
      testOnly: true,
      noPaypalTransaction: true,
      donationId: DONATION_ID,
      donorId: DONOR_ID,
      campaignId: CAMPAIGN_ID,
      amountCents: AMOUNT_CENTS,
      status: "completed",
      note: "Synthetic local test record for B6 receipt and trace APIs.",
    });

    console.log("Test ledger event created.");
  } else {
    console.log("Test ledger event already exists.");
  }

  console.log("\nB6 TEST DATA READY:");
  console.log({
    donationId: donation.id,
    donor: donor.name,
    campaign: campaign.title,
    organization: campaign.organization.name,
    amountCents: donation.amountCents,
    status: donation.status,
    milestoneCount: campaign.milestones.length,
    realPaypalPayment: false,
  });
}

main()
  .catch((error) => {
    console.error("B6 test data setup failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
