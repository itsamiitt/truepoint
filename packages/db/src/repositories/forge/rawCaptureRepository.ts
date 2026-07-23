// rawCaptureRepository — the db-backed land primitive (07 §content_hash idempotency). A plain function (no
// @forge/core import → no cycle); @forge/api adapts it to core's RawCaptureStore port at wiring time. The insert
// is idempotent PER TENANT: ON CONFLICT (target_tenant_id, content_hash) DO NOTHING (P-01.12 — a global
// content_hash unique was a cross-tenant existence oracle + poisoning vector). A replay within a tenant is 0 rows.
import type { Tx } from "../../client.ts";
import { rawCaptures } from "../../schema/forge.ts";

/** The columns the land stage writes. Structurally matches @forge/core's RawCaptureRow (adapted by the API). */
export interface RawCaptureInsert {
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

/** Land a raw capture idempotently on (target_tenant_id, content_hash); returns whether a NEW row was inserted. */
export async function landRawCapture(tx: Tx, row: RawCaptureInsert): Promise<{ landed: boolean }> {
  const inserted = await tx
    .insert(rawCaptures)
    .values({
      source: row.source,
      endpoint: row.endpoint,
      schemaVersion: row.schemaVersion,
      contentHash: row.contentHash,
      contentType: row.contentType,
      capturedByUserId: row.capturedByUserId ?? null,
      targetTenantId: row.targetTenantId,
      targetWorkspaceId: row.targetWorkspaceId ?? null,
      consentSnapshot: row.consentSnapshot ?? {},
      payloadInline: row.payloadInline,
      payloadRef: row.payloadRef,
      byteSize: row.byteSize,
      isGzipped: row.isGzipped,
    })
    .onConflictDoNothing({ target: [rawCaptures.targetTenantId, rawCaptures.contentHash] })
    .returning({ id: rawCaptures.id });

  return { landed: inserted.length > 0 };
}
