
import { randomUUID } from "node:crypto";

import { prisma } from "../src/lib/prisma";
import {
  appendEvent,
  verifyChain,
} from "../src/services/ledger.service";

async function main() {
  // SAFETY CHECK: Never run this test against the real database.
  const databaseInfo = await prisma.$queryRaw<
    Array<{ databaseName: string }>
  >`SELECT current_database() AS "databaseName"`;

  const databaseName = databaseInfo[0]?.databaseName;

  if (databaseName !== "impactledger_ledger_test") {
    throw new Error(
      `SAFETY STOP: Expected impactledger_ledger_test, but connected to ${databaseName}.`
    );
  }

  console.log("Connected to the isolated ledger test database.");

  // Clear previous test events. This is safe only because
  // the database-name check above has passed.
  await prisma.ledgerEvent.deleteMany();

  // ==========================================
  // TEST 1: Sequential ledger events
  // ==========================================

  console.log("\nTEST 1: Creating sequential events...");

  const firstPayload = {
    amountCents: 500,
    currency: "USD",
    metadata: {
      z: "last",
      a: "first",
    },
  };

  const firstEvent = await appendEvent(
    "TEST_DONATION_CREATED",
    randomUUID(),
    firstPayload
  );

  const secondEvent = await appendEvent(
    "TEST_MILESTONE_APPROVED",
    randomUUID(),
    {
      status: "approved",
      amountCents: 500,
    }
  );

  if (firstEvent.prevHash !== null) {
    throw new Error("First event should have a null previous hash.");
  }

  if (secondEvent.prevHash !== firstEvent.hash) {
    throw new Error("Second event is not linked to the first event.");
  }

  console.log("PASS: Sequential hash linking works.");

  // ==========================================
  // TEST 2: Verify the sequential chain
  // ==========================================

  console.log("\nTEST 2: Verifying sequential events...");

  const sequentialResult = await verifyChain();

  if (
    !sequentialResult.valid ||
    sequentialResult.checkedEvents !== 2
  ) {
    throw new Error(
      "Sequential ledger verification failed."
    );
  }

  console.log("PASS: Both sequential events verified.");

  // ==========================================
  // TEST 3: Concurrent ledger writes
  // ==========================================

  console.log("\nTEST 3: Creating 10 concurrent events...");

  const concurrentCount = 10;

  await Promise.all(
    Array.from({ length: concurrentCount }, (_, index) =>
      appendEvent(
        "TEST_CONCURRENT_EVENT",
        randomUUID(),
        {
          sequence: index + 1,
          amountCents: (index + 1) * 100,
          currency: "USD",
        }
      )
    )
  );

  const concurrentResult = await verifyChain();

  if (
    !concurrentResult.valid ||
    concurrentResult.checkedEvents !== 12
  ) {
    throw new Error(
      "Concurrent ledger writes produced an invalid chain."
    );
  }

  console.log(
    "PASS: 10 concurrent writes maintained one unbroken chain."
  );

  // Check the actual previous-hash links in the database.
  const allEvents = await prisma.ledgerEvent.findMany({
    orderBy: [
      { createdAt: "asc" },
      { id: "asc" },
    ],
  });

  for (let i = 0; i < allEvents.length; i++) {
    const expectedPreviousHash =
      i === 0 ? null : allEvents[i - 1].hash;

    if (allEvents[i].prevHash !== expectedPreviousHash) {
      throw new Error(
        `Broken hash link detected at event ${i + 1}.`
      );
    }
  }

  console.log("PASS: Every event links to its actual predecessor.");

  // ==========================================
  // TEST 4: Detect direct database tampering
  // ==========================================

  console.log("\nTEST 4: Simulating database tampering...");

  try {
    // Directly modify the first event without recalculating
    // its stored hash. This deliberately bypasses appendEvent.
    await prisma.ledgerEvent.update({
      where: {
        id: firstEvent.id,
      },
      data: {
        payload: {
          ...firstPayload,
          amountCents: 999999,
        },
      },
    });

    const tamperedResult = await verifyChain();

    if (tamperedResult.valid) {
      throw new Error(
        "SECURITY TEST FAILED: Tampering was not detected."
      );
    }

    if (tamperedResult.failedEventId !== firstEvent.id) {
      throw new Error(
        "Tampering was detected, but the wrong event was reported."
      );
    }

    console.log("PASS: Direct database tampering was detected.");
  } finally {
    // Restore the original test event so the test database
    // does not remain corrupted after the test.
    await prisma.ledgerEvent.update({
      where: {
        id: firstEvent.id,
      },
      data: {
        payload: firstPayload,
      },
    });
  }

  // ==========================================
  // TEST 5: Verify restored chain
  // ==========================================

  console.log("\nTEST 5: Verifying restored ledger...");

  const restoredResult = await verifyChain();

  if (
    !restoredResult.valid ||
    restoredResult.checkedEvents !== 12
  ) {
    throw new Error(
      "Ledger did not return to a valid state after restoration."
    );
  }

  console.log("PASS: Restored ledger is valid.");

  console.log("\nALL LEDGER TESTS PASSED!");
  console.log({
    sequentialEvents: 2,
    concurrentEvents: concurrentCount,
    totalEvents: restoredResult.checkedEvents,
    tamperingDetected: true,
    finalChainValid: restoredResult.valid,
  });
}

main()
  .catch((error: unknown) => {
    console.error("\nLEDGER TEST FAILED:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
