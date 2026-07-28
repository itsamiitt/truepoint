// crmRecordLinkRepository.ts — the external-id <-> contact/account 1:1 map (crm-sync 00 §4.2).
// WORKSPACE-scoped under FORCE RLS; every call runs inside withTenantTx.
//
// This table is THE durable write-idempotency guard for the whole sync engine — not the idempotency-key
// middleware, which is a convenience. Three unique indexes carry the guarantee:
//   uniq_crm_record_links_crm      (connection, crm_object_type, crm_record_id) — one TP entity per CRM record
//   uniq_crm_record_links_contact  (connection, contact_id) partial                — one CRM record per contact
//   uniq_crm_record_links_account  (connection, account_id) partial                — one CRM record per account
// A redelivered webhook, a replayed backfill page and a reconcile poll that all see the same CRM record
// converge on ONE row rather than minting duplicates.

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { crmConnections, crmRecordLinks } from "../schema/crm.ts";

export interface CrmRecordLinkUpsert {
  tenantId: string;
  workspaceId: string;
  connectionId: string;
  tpEntityType: "contact" | "account";
  contactId?: string | null;
  accountId?: string | null;
  crmObjectType: string;
  crmRecordId: string;
  externalKey?: string | null;
  lastSyncedHash?: Uint8Array | null;
  lastInboundModstamp?: Date | null;
}

export interface CrmRecordLinkRecord {
  id: string;
  connectionId: string;
  tpEntityType: string;
  contactId: string | null;
  accountId: string | null;
  crmObjectType: string;
  crmRecordId: string;
  externalKey: string | null;
  lastSyncedHash: Uint8Array | null;
  lastInboundModstamp: Date | null;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  linkStatus: string;
}

const columns = {
  id: crmRecordLinks.id,
  connectionId: crmRecordLinks.connectionId,
  tpEntityType: crmRecordLinks.tpEntityType,
  contactId: crmRecordLinks.contactId,
  accountId: crmRecordLinks.accountId,
  crmObjectType: crmRecordLinks.crmObjectType,
  crmRecordId: crmRecordLinks.crmRecordId,
  externalKey: crmRecordLinks.externalKey,
  lastSyncedHash: crmRecordLinks.lastSyncedHash,
  lastInboundModstamp: crmRecordLinks.lastInboundModstamp,
  lastInboundAt: crmRecordLinks.lastInboundAt,
  lastOutboundAt: crmRecordLinks.lastOutboundAt,
  linkStatus: crmRecordLinks.linkStatus,
};

export const crmRecordLinkRepository = {
  /**
   * Link a CRM record to a TP entity, idempotently.
   *
   * Conflict target is the CRM-side index: the same CRM record seen twice updates the existing row instead
   * of colliding. `lastInboundModstamp` and `lastSyncedHash` are only advanced when the caller supplies
   * them, so an OUTBOUND touch cannot blank the inbound watermark and vice versa — the two directions write
   * disjoint fields of the same row on purpose (00 §6.4 loop prevention keeps their watermarks separate).
   */
  async upsertByCrmRecord(tx: Tx, row: CrmRecordLinkUpsert): Promise<string> {
    const inserted = await tx
      .insert(crmRecordLinks)
      .values({
        tenantId: row.tenantId,
        workspaceId: row.workspaceId,
        connectionId: row.connectionId,
        tpEntityType: row.tpEntityType,
        contactId: row.contactId ?? null,
        accountId: row.accountId ?? null,
        crmObjectType: row.crmObjectType,
        crmRecordId: row.crmRecordId,
        externalKey: row.externalKey ?? null,
        lastSyncedHash: row.lastSyncedHash ?? null,
        lastInboundModstamp: row.lastInboundModstamp ?? null,
      })
      .onConflictDoUpdate({
        target: [
          crmRecordLinks.connectionId,
          crmRecordLinks.crmObjectType,
          crmRecordLinks.crmRecordId,
        ],
        set: {
          updatedAt: sql`now()`,
          ...(row.externalKey != null ? { externalKey: row.externalKey } : {}),
          ...(row.lastSyncedHash != null ? { lastSyncedHash: row.lastSyncedHash } : {}),
          ...(row.lastInboundModstamp != null
            ? { lastInboundModstamp: row.lastInboundModstamp, lastInboundAt: sql`now()` }
            : {}),
        },
      })
      .returning({ id: crmRecordLinks.id });
    return inserted[0]!.id;
  },

  async findByCrmRecord(
    tx: Tx,
    connectionId: string,
    crmObjectType: string,
    crmRecordId: string,
  ): Promise<CrmRecordLinkRecord | null> {
    const rows = await tx
      .select(columns)
      .from(crmRecordLinks)
      .where(
        and(
          eq(crmRecordLinks.connectionId, connectionId),
          eq(crmRecordLinks.crmObjectType, crmObjectType),
          eq(crmRecordLinks.crmRecordId, crmRecordId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /** The outbound fast path: does this contact already exist in the CRM under this connection? */
  async findByContact(
    tx: Tx,
    connectionId: string,
    contactId: string,
  ): Promise<CrmRecordLinkRecord | null> {
    const rows = await tx
      .select(columns)
      .from(crmRecordLinks)
      .where(
        and(eq(crmRecordLinks.connectionId, connectionId), eq(crmRecordLinks.contactId, contactId)),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * Salesforce Lead -> Contact conversion: RE-POINT the existing row (00 §4.2).
   *
   * The one genuinely tricky correctness case in the link table. SFDC converts a Lead into a Contact under a
   * NEW record id; creating a second link row would violate the per-entity unique index (the TP contact
   * already has one) and leave a dangling Lead link behind. Updating this row in place keeps the TP-side
   * uniqueness satisfied and moves the CRM-side key to its new value — no new row, no broken link.
   */
  async repointToConvertedRecord(
    tx: Tx,
    linkId: string,
    newCrmObjectType: string,
    newCrmRecordId: string,
  ): Promise<void> {
    await tx
      .update(crmRecordLinks)
      .set({
        crmObjectType: newCrmObjectType,
        crmRecordId: newCrmRecordId,
        updatedAt: sql`now()`,
      })
      .where(eq(crmRecordLinks.id, linkId));
  },

  /** Stamp a successful outbound push. Deliberately does NOT touch the inbound watermark (§6.4). */
  async markPushed(tx: Tx, linkId: string, lastSyncedHash: Uint8Array): Promise<void> {
    await tx
      .update(crmRecordLinks)
      .set({ lastSyncedHash, lastOutboundAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(crmRecordLinks.id, linkId));
  },

  /**
   * Flag a link the matcher could not resolve confidently. `ambiguous` routes to human review rather than
   * auto-merging — the same posture match_links.review_status takes (00 §4.2).
   */
  async setLinkStatus(
    tx: Tx,
    linkId: string,
    linkStatus: "linked" | "ambiguous" | "broken",
  ): Promise<void> {
    await tx
      .update(crmRecordLinks)
      .set({ linkStatus, updatedAt: sql`now()` })
      .where(eq(crmRecordLinks.id, linkId));
  },

  /**
   * Remove the link after an outbound DSAR erase has been CONFIRMED by the CRM (00 §7.6).
   *
   * Called only by the erase job, and only after the provider confirms. The row is a residual that blocks a
   * DSAR reaching `completed`, so deleting it before confirmation would let a DSAR close while the subject
   * still exists in the customer's CRM. Note the tombstone is a SOFT delete on contacts, so contact_id's
   * ON DELETE cascade never fires for an erased subject — this explicit delete is the only thing that
   * clears the row.
   */
  async deleteAfterErase(tx: Tx, linkId: string): Promise<void> {
    await tx.delete(crmRecordLinks).where(eq(crmRecordLinks.id, linkId));
  },

  /** Links for a contact across every connection — the DSAR residual scan's per-subject read. */
  async listByContact(tx: Tx, contactId: string): Promise<CrmRecordLinkRecord[]> {
    return tx.select(columns).from(crmRecordLinks).where(eq(crmRecordLinks.contactId, contactId));
  },

  /**
   * Every CRM link held by a set of erased contacts — the DSAR fan-out's outbound worklist (00 §7.6).
   *
   * Takes the caller's tx rather than opening its own, because the only caller is deleteFanout, which
   * already runs under withPrivilegedTx. That is deliberate and it is the ONLY cross-workspace read here:
   * a DSAR erases a subject wherever they appear, so the worklist necessarily spans workspaces — the same
   * reason findCopies does. It joins crm_connections for the provider (the erase mode depends on it) and
   * projects ids ONLY, never a credential.
   *
   * Note this returns links for TOMBSTONED contacts. The tombstone is a soft delete, so contact_id's
   * ON DELETE cascade never fires for an erased subject — which is exactly why an explicit outbound erase
   * exists at all.
   */
  async listEraseTargets(
    tx: Tx,
    contactIds: string[],
  ): Promise<
    Array<{
      linkId: string;
      tenantId: string;
      workspaceId: string;
      connectionId: string;
      provider: string;
      crmObjectType: string;
      crmRecordId: string;
      tpEntityType: string;
    }>
  > {
    if (contactIds.length === 0) return [];
    return tx
      .select({
        linkId: crmRecordLinks.id,
        tenantId: crmRecordLinks.tenantId,
        workspaceId: crmRecordLinks.workspaceId,
        connectionId: crmRecordLinks.connectionId,
        provider: crmConnections.provider,
        crmObjectType: crmRecordLinks.crmObjectType,
        crmRecordId: crmRecordLinks.crmRecordId,
        tpEntityType: crmRecordLinks.tpEntityType,
      })
      .from(crmRecordLinks)
      .innerJoin(crmConnections, eq(crmConnections.id, crmRecordLinks.connectionId))
      .where(inArray(crmRecordLinks.contactId, contactIds));
  },
};
