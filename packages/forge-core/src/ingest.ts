// @forge/core ingest — the S0 LAND stage (07 §Verbatim storage, 06 §S0). Pure orchestration over injected
// PORTS so it is unit-testable without live Postgres/Redis/object-store; the real adapters are wired by
// @forge/api (db-backed store, S3 object store, BullMQ parse queue). The verbatim payload is immutable and a
// replayed content_hash is a structural no-op (idempotent on content_hash, mirror source_records §B).
import { OBJECT_STORE_THRESHOLD_BYTES } from "@leadwolf/config";
import { contentHashHex } from "@leadwolf/identity";
import type { CaptureAck, IngestionEnvelopeV2 } from "@leadwolf/types";

/** The raw_captures row the land stage writes (07 §Envelope v2 → raw_captures mapping; schema owned by 05). */
export interface RawCaptureRow {
  source: string;
  endpoint: string;
  schemaVersion: string;
  contentHash: string;
  contentType: string;
  capturedByUserId?: string;
  targetTenantId: string;
  targetWorkspaceId?: string;
  consentSnapshot: unknown;
  payloadInline: string | null;
  payloadRef: string | null;
  byteSize: number;
  isGzipped: boolean;
}

/** Persist a raw capture idempotently on content_hash (INSERT … ON CONFLICT DO NOTHING). db-backed in prod. */
export interface RawCaptureStore {
  land(row: RawCaptureRow): Promise<{ landed: boolean }>;
}

/** Offload a large payload to the object store (SSE-KMS in prod); returns the pointer written to payload_ref. */
export interface ObjectStore {
  put(key: string, bytes: string): Promise<string>;
}

/** Enqueue the parse stage. jobId = content hash → an accidental double-enqueue is a no-op (BullMQ, [S75]). */
export interface ParseQueue {
  enqueue(jobId: string, data: { contentHash: string }): Promise<void>;
}

/** Extended checkCaptureRate — record-volume + payload-byte; FAILS OPEN on outage (ecosystem-facts §A). */
export interface RateLimiter {
  check(
    caller: string,
    records: number,
    bytes: number,
  ): Promise<{ allowed: boolean; retryAfter?: number }>;
}

export interface LandDeps {
  store: RawCaptureStore;
  objectStore: ObjectStore;
  newBatchId: () => string;
}

/** In-memory RateLimiter for dev/test — fixed-window counters. The PROD impl is Redis-backed and FAILS OPEN
 *  on outage (ecosystem-facts §A): abuse ≠ security, so a Redis blip must never halt capture. */
export function inMemoryRateLimiter(opts: { recordLimit: number; byteLimit: number }): RateLimiter {
  const windows = new Map<string, { minute: number; records: number; bytes: number }>();
  return {
    async check(caller, records, bytes) {
      const now = Date.now();
      const minute = Math.floor(now / 60_000);
      const prev = windows.get(caller);
      const cur = prev && prev.minute === minute ? prev : { minute, records: 0, bytes: 0 };
      cur.records += records;
      cur.bytes += bytes;
      windows.set(caller, cur);
      if (cur.records > opts.recordLimit || cur.bytes > opts.byteLimit) {
        return { allowed: false, retryAfter: 60 - Math.floor((now % 60_000) / 1000) };
      }
      return { allowed: true };
    },
  };
}

/** In-memory ObjectStore for dev/test (mirrors TruePoint's inMemorySearchPort). Real S3/MinIO adapter is P8/16. */
export function inMemoryObjectStore(): ObjectStore & { readonly blobs: Map<string, string> } {
  const blobs = new Map<string, string>();
  return {
    blobs,
    async put(key, bytes) {
      blobs.set(key, bytes);
      return `mem://${key}`;
    },
  };
}

/** Server-authoritative capture hash (P-01.11): the stable content hash of the payload ITSELF, never the
 *  client-declared record.contentHash. Canonical JSON when the payload parses (order-independent dedup), else
 *  the raw bytes. Recomputing on the server is what makes the per-tenant dedup key trustworthy — a client can no
 *  longer pre-claim or forge another capture's identity (hash poisoning / cross-tenant oracle, P-01.12). */
function captureHash(rawPayload: string): string {
  try {
    return contentHashHex(JSON.parse(rawPayload));
  } catch {
    return contentHashHex(rawPayload);
  }
}

/** Route a payload: small → inline JSONB; large → object store under a TENANT-prefixed hash key, pointer in row.
 *  The tenant prefix keeps identical content in two tenants from sharing one blob — otherwise one tenant's DSAR
 *  erasure would delete the other's payload, and the shared key space would be a cross-tenant probe (P-01.12). */
async function routePayload(
  deps: LandDeps,
  args: { rawPayload: string; contentHash: string; byteSize: number; tenantId: string },
): Promise<{ inline: string | null; ref: string | null }> {
  if (args.byteSize > OBJECT_STORE_THRESHOLD_BYTES) {
    const key = `${args.tenantId}/${args.contentHash.slice(0, 4)}/${args.contentHash}`;
    const ref = await deps.objectStore.put(key, args.rawPayload);
    return { inline: null, ref };
  }
  return { inline: args.rawPayload, ref: null };
}

/** Land an envelope v2 verbatim; RETURN the content-hashes that landed for a POST-COMMIT parse enqueue (P-01.7).
 *  A replayed content_hash lands nothing (idempotent on content_hash). */
export async function landEnvelope(
  deps: LandDeps,
  envelope: IngestionEnvelopeV2,
): Promise<{ ack: CaptureAck; landed: string[] }> {
  const batchId = deps.newBatchId();
  const landedHashes: string[] = [];
  let duplicate = 0;

  for (const record of envelope.records) {
    // Recompute the content hash server-side (P-01.11) — the client-declared record.contentHash is advisory and
    // never trusted; it can't select, pre-claim, or poison another capture's identity.
    const contentHash = captureHash(record.rawPayload);
    const { inline, ref } = await routePayload(deps, {
      rawPayload: record.rawPayload,
      contentHash,
      byteSize: record.byteSize,
      tenantId: envelope.scope.tenantId,
    });
    const { landed } = await deps.store.land({
      source: envelope.source,
      endpoint: record.endpoint,
      schemaVersion: record.schemaVersion,
      contentHash,
      contentType: record.contentType,
      capturedByUserId: envelope.capturedBy,
      targetTenantId: envelope.scope.tenantId,
      targetWorkspaceId: envelope.scope.workspaceId,
      consentSnapshot: envelope.consent ?? null,
      payloadInline: inline,
      payloadRef: ref,
      byteSize: record.byteSize,
      isGzipped: envelope.gzip,
    });

    if (landed) {
      landedHashes.push(contentHash);
    } else {
      duplicate += 1;
    }
  }

  // The parse enqueue happens AFTER this tx commits (P-01.7): landEnvelope only RECORDS what landed; @forge/api
  // enqueues `landed` post-commit, so a parse job is never dispatched before its raw_captures row exists and a
  // rolled-back envelope enqueues nothing. A crash between commit and enqueue is recovered by the maintenance
  // reconciliation sweep (follow-on).
  return {
    ack: { batchId, accepted: landedHashes.length, duplicate, rejected: 0 },
    landed: landedHashes,
  };
}
