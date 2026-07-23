import { describe, expect, test } from "bun:test";
import { contentHashHex } from "@leadwolf/identity";
import type { IngestionEnvelopeV2 } from "@leadwolf/types";
import {
  type LandDeps,
  type RawCaptureRow,
  inMemoryObjectStore,
  landEnvelope,
} from "../src/index.ts";

const TENANT_A = "00000000-0000-0000-0000-000000000001";
const TENANT_B = "00000000-0000-0000-0000-000000000002";
/** The server-authoritative hash the land stage recomputes — identity comes from the payload, never the client. */
const H = (payload: unknown) => contentHashHex(payload);

/** In-memory store that dedups PER TENANT (mirrors the real ON CONFLICT (target_tenant_id, content_hash), P-01.12). */
function fakeStore() {
  const seen = new Set<string>();
  const rows: RawCaptureRow[] = [];
  return {
    rows,
    land: async (row: RawCaptureRow) => {
      rows.push(row);
      const key = `${row.targetTenantId}:${row.contentHash}`;
      if (seen.has(key)) return { landed: false };
      seen.add(key);
      return { landed: true };
    },
  };
}

function envelope(
  records: Array<{ rawPayload?: string; contentHash?: string; byteSize?: number }>,
  scope: { tenantId: string; workspaceId?: string } = { tenantId: TENANT_A },
): IngestionEnvelopeV2 {
  return {
    envelopeVersion: "2",
    source: "chrome_extension",
    scope,
    idempotencyKey: "k",
    collectedAt: "2026-07-06T00:00:00.000Z",
    gzip: false,
    size: records.reduce((n, r) => n + (r.byteSize ?? 2), 0),
    records: records.map((r) => ({
      rawPayload: r.rawPayload ?? "{}",
      endpoint: "voyager/identity/profiles",
      schemaVersion: "1-0-0",
      contentType: "application/json",
      // Client-declared hash — the server IGNORES this and recomputes from rawPayload (P-01.11).
      contentHash: r.contentHash ?? "deadbeef",
      capturedAt: "2026-07-06T00:00:00.000Z",
      byteSize: r.byteSize ?? 2,
    })),
  };
}

describe("landEnvelope (S0 land stage)", () => {
  test("a new record lands under the SERVER-recomputed hash; a replay is a no-op (idempotent)", async () => {
    const store = fakeStore();
    const deps: LandDeps = {
      store,
      objectStore: inMemoryObjectStore(),
      newBatchId: () => "batch-1",
    };

    const first = await landEnvelope(deps, envelope([{ rawPayload: `{"a":1}` }]));
    expect(first.ack.accepted).toBe(1);
    expect(first.ack.duplicate).toBe(0);
    expect(first.landed).toEqual([H({ a: 1 })]); // the SERVER hash (post-commit enqueue key, P-01.7), not the client's

    const replay = await landEnvelope(deps, envelope([{ rawPayload: `{"a":1}` }]));
    expect(replay.ack.accepted).toBe(0);
    expect(replay.ack.duplicate).toBe(1);
    expect(replay.landed).toEqual([]); // a replay lands nothing → enqueues nothing
  });

  test("the client-declared contentHash is ignored — identity comes from the payload (P-01.11)", async () => {
    const store = fakeStore();
    const deps: LandDeps = { store, objectStore: inMemoryObjectStore(), newBatchId: () => "b" };

    // Same payload, DIFFERENT (lying) client hashes: the server recomputes both to the same hash → the 2nd dedups.
    const res = await landEnvelope(
      deps,
      envelope([
        { rawPayload: `{"x":1}`, contentHash: "a".repeat(64) },
        { rawPayload: `{"x":1}`, contentHash: "b".repeat(64) },
      ]),
    );
    expect(res.ack.accepted).toBe(1);
    expect(res.ack.duplicate).toBe(1);
    expect(store.rows.every((r) => r.contentHash === H({ x: 1 }))).toBe(true); // stored under the server hash
  });

  test("canonicalization: key order does not change identity (order-independent dedup)", async () => {
    const store = fakeStore();
    const deps: LandDeps = { store, objectStore: inMemoryObjectStore(), newBatchId: () => "b" };
    const res = await landEnvelope(
      deps,
      envelope([{ rawPayload: `{"a":1,"b":2}` }, { rawPayload: `{"b":2,"a":1}` }]),
    );
    expect(res.ack.accepted).toBe(1); // same canonical content → one lands, the reorder dedups
    expect(res.ack.duplicate).toBe(1);
  });

  test("dedup is per-tenant — identical content in two tenants BOTH land (no cross-tenant oracle, P-01.12)", async () => {
    const store = fakeStore();
    const deps: LandDeps = { store, objectStore: inMemoryObjectStore(), newBatchId: () => "b" };

    const a = await landEnvelope(deps, envelope([{ rawPayload: `{"same":1}` }], { tenantId: TENANT_A }));
    const b = await landEnvelope(deps, envelope([{ rawPayload: `{"same":1}` }], { tenantId: TENANT_B }));
    expect(a.ack.accepted).toBe(1);
    expect(b.ack.accepted).toBe(1); // tenant B is NOT deduped away by tenant A's identical capture
    expect(b.ack.duplicate).toBe(0);
  });

  test("a large payload offloads to the object store under a TENANT-prefixed key (P-01.12)", async () => {
    const store = fakeStore();
    const obj = inMemoryObjectStore();
    const deps: LandDeps = { store, objectStore: obj, newBatchId: () => "b" };

    const big = JSON.stringify({ blob: "x".repeat(100 * 1024) });
    await landEnvelope(
      deps,
      envelope([{ rawPayload: big, byteSize: big.length }], { tenantId: TENANT_A }),
    );
    const row = store.rows[0];
    expect(row?.payloadRef).toMatch(/^mem:\/\//);
    expect(row?.payloadInline).toBeNull();
    expect(obj.blobs.size).toBe(1);
    expect([...obj.blobs.keys()][0]?.startsWith(`${TENANT_A}/`)).toBe(true); // tenant-isolated blob key
  });
});
