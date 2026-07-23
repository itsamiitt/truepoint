// promotionRepository — the four-eyes promotion write-set (10 §5), a plain function the API/worker adapts to
// @forge/core's PromotionTx port (no db→core cycle). Writes verified_records + verified_record_events +
// sync_state + sync_outbox (row 5 in the SAME tx — no dual-write, [S20]) + hash-chained forge_audit_log, ALL
// in ONE transaction. Idempotent on content_hash: a replayed approval returns { written: false }. The caller
// wraps the whole call in withForgeTx; this function runs its multi-write body directly on the injected tx.
import { createHash } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import type { Tx } from "../../client.ts";
import {
  approvalRequests,
  forgeAuditLog,
  syncOutbox,
  syncState,
  verifiedRecordEvents,
  verifiedRecords,
} from "../../schema/forge.ts";

export interface PromotionInput {
  candidate: {
    contentHash: string;
    entityKind: "person" | "company";
    fields: unknown;
    confidence: number;
    channels?: { emailBlindIndex?: string; phoneBlindIndex?: string };
  };
  approvalRequestId: string;
  approvedByUserId: string;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export async function promoteVerifiedRecord(
  tx: Tx,
  input: PromotionInput,
): Promise<{ verifiedId: string; written: boolean }> {
  const c = input.candidate;

  // Row 1 — verified_records UPSERT, idempotent on content_hash.
  const inserted = await tx
    .insert(verifiedRecords)
    .values({
      contentHash: c.contentHash,
      entityKind: c.entityKind,
      fields: c.fields,
      confidence: c.confidence.toFixed(3),
      reviewStatus: "verified",
      emailBlindIndex: c.channels?.emailBlindIndex ?? null,
      phoneBlindIndex: c.channels?.phoneBlindIndex ?? null,
      approvedByUserId: input.approvedByUserId,
      approvalRequestId: input.approvalRequestId,
      verifiedAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing({ target: verifiedRecords.contentHash })
    .returning({ id: verifiedRecords.id });

  if (inserted.length === 0) {
    const existing = await tx
      .select({ id: verifiedRecords.id })
      .from(verifiedRecords)
      .where(eq(verifiedRecords.contentHash, c.contentHash))
      .limit(1);
    return { verifiedId: existing[0]?.id ?? "", written: false };
  }
  const verifiedId = inserted[0]?.id ?? "";

  // Row 4 — verified_record_events (event-sourced history).
  await tx.insert(verifiedRecordEvents).values({ verifiedId, eventType: "verified", version: 1 });

  // Row 6 — sync_state ledger.
  await tx
    .insert(syncState)
    .values({ entityKind: c.entityKind, verifiedId, status: "pending" })
    .onConflictDoNothing({ target: [syncState.entityKind, syncState.verifiedId] });

  // Row 5 — sync_outbox in the SAME tx (transactional outbox; ciphertext + blind index + content_hash, NO clear PII).
  await tx.insert(syncOutbox).values({
    eventType: "verified.upserted",
    aggregateKind: c.entityKind === "company" ? "verified_company" : "verified_person",
    forgeId: verifiedId,
    version: 1,
    contentHash: c.contentHash,
    payload: {
      contentHash: c.contentHash,
      entityKind: c.entityKind,
      emailBlindIndex: c.channels?.emailBlindIndex ?? null,
      phoneBlindIndex: c.channels?.phoneBlindIndex ?? null,
    },
  });

  // Row 7 — approval_requests → executed.
  await tx
    .update(approvalRequests)
    .set({ status: "executed", decidedByUserId: input.approvedByUserId, executedAt: new Date() })
    .where(eq(approvalRequests.id, input.approvalRequestId));

  // Row 8 — forge_audit_log, hash-chained (row_hash = H(prev_hash ‖ canonical), 10 §7). Serialize the append
  // with a transaction-scoped advisory lock (P-01.18): without it two concurrent promotions both read the same
  // head row and insert with the SAME prev_hash, FORKING the chain and silently destroying tamper-evidence. The
  // lock releases at commit; contention is negligible (promotions are human-paced; the section is one read + one
  // insert).
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('forge_audit_log')::bigint)`);
  const prev = await tx
    .select({ rowHash: forgeAuditLog.rowHash })
    .from(forgeAuditLog)
    .orderBy(desc(forgeAuditLog.seq))
    .limit(1);
  const prevHash = prev[0]?.rowHash ?? "GENESIS";
  const canonical = JSON.stringify({
    action: "verify.promoted",
    actorKind: "human",
    actorId: input.approvedByUserId,
    payload: { contentHash: c.contentHash, verifiedId },
  });
  await tx.insert(forgeAuditLog).values({
    action: "verify.promoted",
    actorKind: "human",
    actorId: input.approvedByUserId,
    payload: { contentHash: c.contentHash, verifiedId },
    prevHash,
    rowHash: sha256(`${prevHash}\n${canonical}`),
  });

  return { verifiedId, written: true };
}
