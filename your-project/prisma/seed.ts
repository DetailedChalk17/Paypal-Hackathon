
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Starting ImpactLedger database seeding...");

  // ==========================================
  // 1. CREATE DEMO USERS
  // ==========================================

  const donor = await prisma.user.upsert({
    where: { email: "donor@example.com" },
    update: {
      name: "Demo Donor",
      role: "donor",
    },
    create: {
      id: "10000000-0000-4000-8000-000000000001",
      name: "Demo Donor",
      email: "donor@example.com",
      role: "donor",
    },
  });

  const organizer = await prisma.user.upsert({
    where: { email: "organizer@example.com" },
    update: {
      name: "Demo Organizer",
      role: "organizer",
    },
    create: {
      id: "10000000-0000-4000-8000-000000000002",
      name: "Demo Organizer",
      email: "organizer@example.com",
      role: "organizer",
    },
  });

  const reviewer = await prisma.user.upsert({
    where: { email: "reviewer@example.com" },
    update: {
      name: "Demo Reviewer",
      role: "reviewer",
    },
    create: {
      id: "10000000-0000-4000-8000-000000000003",
      name: "Demo Reviewer",
      email: "reviewer@example.com",
      role: "reviewer",
    },
  });

  console.log("Created/updated 3 demo users.");

  // ==========================================
  // 2. CREATE DEMO ORGANIZATIONS
  // ==========================================

  const organizations = [
    {
      id: "20000000-0000-4000-8000-000000000001",
      name: "Green Earth Collective",
      cause: "Environment",
      location: "Bengaluru",
      payoutEmail: "payments@greenearth.example",
      verified: true,
      trustScore: 88,
    },
    {
      id: "20000000-0000-4000-8000-000000000002",
      name: "Bright Futures Foundation",
      cause: "Education",
      location: "Mysuru",
      payoutEmail: "payments@brightfutures.example",
      verified: true,
      trustScore: 94,
    },
    {
      id: "20000000-0000-4000-8000-000000000003",
      name: "Community Health Bridge",
      cause: "Healthcare",
      location: "Bengaluru",
      payoutEmail: "payments@healthbridge.example",
      verified: true,
      trustScore: 82,
    },
    {
      id: "20000000-0000-4000-8000-000000000004",
      name: "Safe Water Initiative",
      cause: "Water and Sanitation",
      location: "Hubballi",
      payoutEmail: "payments@safewater.example",
      verified: true,
      trustScore: 76,
    },
    {
      id: "20000000-0000-4000-8000-000000000005",
      name: "Women Forward Network",
      cause: "Women Empowerment",
      location: "Mangaluru",
      payoutEmail: "payments@womenforward.example",
      verified: true,
      trustScore: 91,
    },
    {
      id: "20000000-0000-4000-8000-000000000006",
      name: "Rural Skills Foundation",
      cause: "Livelihoods",
      location: "Tumakuru",
      payoutEmail: "payments@ruralskills.example",
      verified: false,
      trustScore: 73,
    },
    {
      id: "20000000-0000-4000-8000-000000000007",
      name: "Animal Care Alliance",
      cause: "Animal Welfare",
      location: "Bengaluru",
      payoutEmail: "payments@animalcare.example",
      verified: true,
      trustScore: 68,
    },
    {
      id: "20000000-0000-4000-8000-000000000008",
      name: "Food for Every Family",
      cause: "Hunger Relief",
      location: "Shivamogga",
      payoutEmail: "payments@foodfamily.example",
      verified: true,
      trustScore: 85,
    },
  ];

  for (const organization of organizations) {
    await prisma.organization.upsert({
      where: { id: organization.id },
      update: organization,
      create: organization,
    });
  }

  console.log("Created/updated 8 demo organizations.");

  // ==========================================
  // 3. CREATE DEMO CAMPAIGNS
  // ==========================================

  const campaigns = [
    {
      id: "30000000-0000-4000-8000-000000000001",
      organizationId: organizations[0].id,
      title: "Urban Tree Restoration",
      goalAmountCents: 2500000,
    },
    {
      id: "30000000-0000-4000-8000-000000000002",
      organizationId: organizations[1].id,
      title: "Digital Classrooms for Rural Schools",
      goalAmountCents: 3000000,
    },
    {
      id: "30000000-0000-4000-8000-000000000003",
      organizationId: organizations[2].id,
      title: "Mobile Healthcare Clinics",
      goalAmountCents: 4000000,
    },
    {
      id: "30000000-0000-4000-8000-000000000004",
      organizationId: organizations[3].id,
      title: "Clean Drinking Water for Villages",
      goalAmountCents: 2000000,
    },
    {
      id: "30000000-0000-4000-8000-000000000005",
      organizationId: organizations[4].id,
      title: "Women Entrepreneurship Program",
      goalAmountCents: 1800000,
    },
    {
      id: "30000000-0000-4000-8000-000000000006",
      organizationId: organizations[5].id,
      title: "Rural Digital Skills Training",
      goalAmountCents: 1500000,
    },
    {
      id: "30000000-0000-4000-8000-000000000007",
      organizationId: organizations[6].id,
      title: "Veterinary Outreach Program",
      goalAmountCents: 1200000,
    },
    {
      id: "30000000-0000-4000-8000-000000000008",
      organizationId: organizations[7].id,
      title: "Nutrition Support for Families",
      goalAmountCents: 2200000,
    },
  ];

  for (const campaign of campaigns) {
    await prisma.campaign.upsert({
      where: { id: campaign.id },
      update: {
        ...campaign,
        organizerId: organizer.id,
        currency: "USD",
        status: "active",
      },
      create: {
        ...campaign,
        organizerId: organizer.id,
        currency: "USD",
        status: "active",
      },
    });
  }

  console.log("Created/updated 8 demo campaigns.");

  // ==========================================
  // 4. CREATE TWO MILESTONES PER CAMPAIGN
  // ==========================================

  let milestoneNumber = 1;

  for (const campaign of campaigns) {
    const firstBudget = Math.floor(
      campaign.goalAmountCents * 0.4
    );

    const secondBudget =
      campaign.goalAmountCents - firstBudget;

    const milestoneData = [
      {
        id: `40000000-0000-4000-8000-${String(milestoneNumber++).padStart(12, "0")}`,
        campaignId: campaign.id,
        title: "Planning and Procurement",
        budgetAmountCents: firstBudget,
        status: "open" as const,
      },
      {
        id: `40000000-0000-4000-8000-${String(milestoneNumber++).padStart(12, "0")}`,
        campaignId: campaign.id,
        title: "Implementation and Delivery",
        budgetAmountCents: secondBudget,
        status: "open" as const,
      },
    ];

    for (const milestone of milestoneData) {
      await prisma.milestone.upsert({
        where: { id: milestone.id },
        update: milestone,
        create: milestone,
      });
    }
  }

  console.log("Created/updated 16 demo milestones.");

  console.log("\nImpactLedger database seeding completed!");
  console.log({
    users: 3,
    organizations: 8,
    campaigns: 8,
    milestones: 16,
  });
}

main()
  .catch((error: unknown) => {
    console.error("Database seeding failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
