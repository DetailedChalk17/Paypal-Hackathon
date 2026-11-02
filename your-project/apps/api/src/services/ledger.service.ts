
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

// JSON values supported by PostgreSQL JSON.
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// Normalize JSON recursively so object key order is deterministic.
function canonicalizeJson(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        "Ledger payload cannot contain NaN or Infinity."
      );
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(
        "Ledger payload must contain plain JSON objects."
      );
    }

    const input = value as Record<string, unknown>;
    const sorted: Record<string, JsonValue> = {};

    for (const key of Object.keys(input).sort()) {
      if (input[key] === undefined) {
        throw new Error(
          `Undefined ledger payload value: ${key}`
        );
      }

      sorted[key] = canonicalizeJson(input[key]);
    }

    return sorted;
  }

  throw new Error(
    "Ledger payload contains a non-JSON value."
  );
}

// Calculate the SHA-256 hash for an event.
function calculateHash(
  prevHash: string | null,
  type: string,
  entityId: string,
  payload: JsonValue,
  createdAt: Date
): string {
  const hashInput = JSON.stringify([
    prevHash,
    type,
    entityId,
    payload,
    createdAt.toISOString(),
  ]);

  return createHash("sha256")
    .update(hashInput, "utf8")
    .digest("hex");
}

// Acquire a transaction-level PostgreSQL advisory lock.
// Retry while another transaction holds the lock.
async function acquireLedgerLock(
  tx: Prisma.TransactionClient
): Promise<void> {
  const timeoutAt = Date.now() + 30000;

  while (Date.now() < timeoutAt) {
    const result = await tx.$queryRaw<
      Array<{ locked: boolean }>
    >`
      SELECT pg_try_advisory_xact_lock(741852, 42004) AS locked
    `;

    if (result[0]?.locked === true) {
      return;
    }

    // Wait briefly before retrying.
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(
    "Timed out while acquiring the ledger lock."
  );
}

// ==========================================
// APPEND EVENT
// ==========================================

export async function appendEvent(
  type: string,
  entityId: string,
  payload: Record<string, unknown>
) {
  const normalizedType = type.trim();

  if (!normalizedType) {
    throw new Error(
      "Ledger event type cannot be empty."
    );
  }

  if (!entityId) {
    throw new Error(
      "Ledger entity ID cannot be empty."
    );
  }

  const canonicalPayload = canonicalizeJson(payload);

  if (
    canonicalPayload === null ||
    Array.isArray(canonicalPayload) ||
    typeof canonicalPayload !== "object"
  ) {
    throw new Error(
      "Ledger payload must be a JSON object."
    );
  }

  const dbPayload =
    canonicalPayload as Prisma.InputJsonObject;

  // All ledger writes use the same advisory lock.
  // This protects concurrent writes and an empty ledger.
  return prisma.$transaction(
    async (tx) => {
      await acquireLedgerLock(tx);

      // Read the latest event after acquiring the lock.
      const latestEvent = await tx.ledgerEvent.findFirst({
        orderBy: {
          createdAt: "desc",
        },
        select: {
          hash: true,
          createdAt: true,
        },
      });

      const prevHash = latestEvent?.hash ?? null;

      // Ensure timestamps are strictly increasing.
      const now = new Date();

      const createdAt =
        latestEvent &&
        now.getTime() <= latestEvent.createdAt.getTime()
          ? new Date(
              latestEvent.createdAt.getTime() + 1
            )
          : now;

      // Calculate the new event hash.
      const hash = calculateHash(
        prevHash,
        normalizedType,
        entityId,
        canonicalPayload,
        createdAt
      );

      // Save event and hash in the same transaction.
      return tx.ledgerEvent.create({
        data: {
          type: normalizedType,
          entityId,
          payload: dbPayload,
          prevHash,
          hash,
          createdAt,
        },
      });
    },
    {
      // Wait up to 10 seconds to acquire a transaction.
      maxWait: 10000,

      // Allow time for the advisory-lock retry process.
      timeout: 35000,
    }
  );
}

// ==========================================
// VERIFY HASH CHAIN
// ==========================================

export async function verifyChain() {
  const events = await prisma.ledgerEvent.findMany({
    orderBy: [
      { createdAt: "asc" },
      { id: "asc" },
    ],
  });

  let expectedPrevHash: string | null = null;

  const latestHash =
    events.length > 0
      ? events[events.length - 1].hash
      : null;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    // 1. Check the previous hash reference.
    if (event.prevHash !== expectedPrevHash) {
      return {
        valid: false,
        checkedEvents: i + 1,
        failedEventId: event.id,
        reason:
          "Previous hash does not match the preceding event.",
        latestHash,
      };
    }

    // 2. Normalize the stored payload.
    let payload: JsonValue;

    try {
      payload = canonicalizeJson(event.payload);
    } catch {
      return {
        valid: false,
        checkedEvents: i + 1,
        failedEventId: event.id,
        reason: "Ledger payload contains invalid JSON data.",
        latestHash,
      };
    }

    if (
      payload === null ||
      Array.isArray(payload) ||
      typeof payload !== "object"
    ) {
      return {
        valid: false,
        checkedEvents: i + 1,
        failedEventId: event.id,
        reason: "Ledger payload is not a JSON object.",
        latestHash,
      };
    }

    // 3. Recalculate the event hash.
    const calculatedHash = calculateHash(
      expectedPrevHash,
      event.type,
      event.entityId,
      payload,
      event.createdAt
    );

    // 4. Compare calculated and stored hashes.
    if (calculatedHash !== event.hash) {
      return {
        valid: false,
        checkedEvents: i + 1,
        failedEventId: event.id,
        reason:
          "Event hash does not match the stored data.",
        latestHash,
      };
    }

    // 5. Move to the next event.
    expectedPrevHash = event.hash;
  }

  return {
    valid: true,
    checkedEvents: events.length,
    latestHash,
  };
}
