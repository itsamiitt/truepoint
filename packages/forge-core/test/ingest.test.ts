import { describe, expect, test } from "bun:test";
import type { IngestionEnvelopeV2 } from "@leadwolf/types";
import {
  type LandDeps,
  type RawCaptureRow,
  inMemoryObjectStore,
  landEnvelope,
} from "../src/index.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function fakeStore() {
  const seen = new Set<string>();
  const rows: RawCaptureRow[] = [];
  return {
    rows,
    land: async (row: RawCaptureRow) => {
      rows.push(row);
      if (seen.has(row.contentHash)) return { landed: false };
      seen.add(row.contentHash);
      return { landed: true };
    },
  };
}

function envelope(records: Array<{ contentHash: string; byteSize: number }>): IngestionEnvelopeV2 {
  return {
    envelopeVersion: "2",
    source: "chrome_extension",
    scope: { tenantId: "00000000-0000-0000-0000-000000000001" },
    idempotencyKey: "k",
    collectedAt: "2026-07-06T00:00:00.000Z",
    gzip: false,
    size: records.reduce((n, r) => n + r.byteSize, 0),
    records: records.map((r) => ({
      rawPayload: "{}",
      endpoint: "voyager/identity/profiles",
      schemaVersion: "1-0-0",
      contentType: "application/json",
      contentHash: r.contentHash,
      capturedAt: "2026-07-06T00:00:00.000Z",
      byteSize: r.byteSize,
    })),
  };
}

describe("landEnvelope (S0 land stage)", () => {
  test("a new record lands + enqueues; a replay is a no-op (idempotent on content_hash)", async () => {
    const store = fakeStore();
    const enqueued: string[] = [];
    const deps: LandDeps = {
      store,
      objectStore: inMemoryObjectStore(),
      enqueue: {
        enqueue: async (jobId) => {
          enqueued.push(jobId);
        },
      },
      newBatchId: () => "batch-1",
    };

    const first = await landEnvelope(deps, envelope([{ contentHash: HASH_A, byteSize: 2 }]));
    expect(first.accepted).toBe(1);
    expect(first.duplicate).toBe(0);
    expect(enqueued).toEqual([HASH_A]);

    const replay = await landEnvelope(deps, envelope([{ contentHash: HASH_A, byteSize: 2 }]));
    expect(replay.accepted).toBe(0);
    expect(replay.duplicate).toBe(1);
    expect(enqueued).toEqual([HASH_A]); // NOT enqueued again — a double-enqueue is ignored
  });

  test("a large payload offloads to the object store (pointer in row, not inline)", async () => {
    const store = fakeStore();
    const obj = inMemoryObjectStore();
    const deps: LandDeps = {
      store,
      objectStore: obj,
      enqueue: { enqueue: async () => {} },
      newBatchId: () => "b",
    };

    await landEnvelope(deps, envelope([{ contentHash: HASH_B, byteSize: 100 * 1024 }]));
    const row = store.rows[0];
    expect(row?.payloadRef).toMatch(/^mem:\/\//);
    expect(row?.payloadInline).toBeNull();
    expect(obj.blobs.size).toBe(1);
  });
});
