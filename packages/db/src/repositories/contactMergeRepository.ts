// contactMergeRepository.ts — the transactional EXECUTOR half of the contact TRUE-MERGE engine
// (import-and-data-model-redesign 04 §3.3/§3.4; S-C4). Every op here runs inside the CALLER's withTenantTx
// (packages/core's runContactMerge), so the survivor field writes, the type-aware channel demotion, the
// COMPLETE Class-A child re-point inventory, the loser tombstone, and the contact.merge audit event commit or
// roll back AS ONE (04 §pre-build failure-modes: nothing half-merged exists; retry-safe via Idempotency-Key).
// The PURE field-union decision lives in core (contactMergePlan.ts) and is passed in — this layer never
// re-expresses the pin rules as SQL (data-management/15 §1). RLS on the caller's tx is the tenant wall (DM4);
// the customer merge runs on withTenantTx, NEVER the owner path (04 §pre-build security).
//
// THE TWO CHILD CLASSES (04 §3.4):
//   • Class A — live operational rows: RE-POINT to the survivor (every row ends referencing the survivor, or
//     is collapsed away — T1 asserts ZERO Class-A rows still referencing a tombstoned loser). Collision rules
//     per table's unique: list/tag/reveal/outreach collisions collapse (union / never-double-charge); email
//     re-point never collides (the 05 §2.2 ws-value unique keeps loser≠survivor); phone collisions collapse
//     onto the survivor's live row (the loser's becomes a deleted tombstone ON the survivor — still off the
//     loser, so T1 holds).
//   • Class B — job ledgers (import_job_rows / enrichment_job_rows / reveal_job_rows / provider_calls): NEVER
//     rewritten (rewriting falsifies history). They keep pointing at the loser; the loser's SOFT tombstone +
//     merged_into_contact_id provides the traversal hop, and no FK breaks (nothing cascades on a soft delete).

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { activities } from "../schema/activity.ts";
import { auditLog, contactReveals, suppressionList } from "../schema/billing.ts";
import { consentRecords } from "../schema/compliance.ts";
import { contactEmails, contactPhones } from "../schema/contactChannels.ts";
import { contacts, sourceImports } from "../schema/contacts.ts";
import { emailEvent, emailMessage, emailThread } from "../schema/email.ts";
import { intentSignals, scores } from "../schema/intel.ts";
import { listMembers } from "../schema/lists.ts";
import { outreachLog } from "../schema/outreach.ts";
import { salesNavLinks } from "../schema/salesnav.ts";
import { recordTags } from "../schema/tags.ts";

/** The merge-relevant columns of one contact side, read under FOR UPDATE (04 §pre-build edge: deterministic
 *  lock order prevents the concurrent A→B / B→A race). */
export interface ContactMergeRow {
  id: string;
  tenantId: string;
  workspaceId: string;
  deletedAt: Date | null;
  mergedIntoContactId: string | null;
  accountId: string | null;
  ownerUserId: string | null;
  masterPersonId: string | null;
  isRevealed: boolean;
  revealedByUserId: string | null;
  revealedAt: Date | null;
  lastActivityAt: Date | null;
  customFields: Record<string, unknown>;
  fieldProvenance: Record<string, unknown>;
  firstName: string | null;
  lastName: string | null;
  jobTitle: string | null;
  seniorityLevel: string | null;
  department: string | null;
  locationCountry: string | null;
  locationCity: string | null;
}

/** The survivor write-set the executor applies (computed by core: the pure plan + the 04 §1 blank-fills). */
export interface SurvivorWriteSet {
  scalarWrites: Record<string, string | null>;
  provenance: Record<string, unknown>;
  customFields: Record<string, unknown>;
  /** 04 §1 "blank fills from loser" for the non-scalar keeps + reveal-trio adoption + last_activity max. */
  accountId?: string | null;
  ownerUserId?: string | null;
  masterPersonId?: string | null;
  isRevealed?: boolean;
  revealedByUserId?: string | null;
  revealedAt?: Date | null;
  lastActivityAt?: Date | null;
}

const n = <T>(rows: T[]): number => rows.length;

export const contactMergeRepository = {
  /**
   * Lock BOTH contacts FOR UPDATE in deterministic id order (least id first — the concurrent-merge race guard,
   * 04 §pre-build edge) and load their merge-relevant columns. RLS scopes the read to the caller's workspace,
   * so a foreign/cross-tenant id is simply ABSENT from the result (the IDOR guard — no cross-workspace row is
   * ever read or locked). Returns each side or `undefined` when not visible-and-present.
   */
  async lockAndLoadPair(
    tx: Tx,
    survivorContactId: string,
    loserContactId: string,
  ): Promise<{ survivor?: ContactMergeRow; loser?: ContactMergeRow }> {
    const ids: string[] = [survivorContactId, loserContactId].sort();
    const rows = await tx
      .select({
        id: contacts.id,
        tenantId: contacts.tenantId,
        workspaceId: contacts.workspaceId,
        deletedAt: contacts.deletedAt,
        mergedIntoContactId: contacts.mergedIntoContactId,
        accountId: contacts.accountId,
        ownerUserId: contacts.ownerUserId,
        masterPersonId: contacts.masterPersonId,
        isRevealed: contacts.isRevealed,
        revealedByUserId: contacts.revealedByUserId,
        revealedAt: contacts.revealedAt,
        lastActivityAt: contacts.lastActivityAt,
        customFields: contacts.customFields,
        fieldProvenance: contacts.fieldProvenance,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        jobTitle: contacts.jobTitle,
        seniorityLevel: contacts.seniorityLevel,
        department: contacts.department,
        locationCountry: contacts.locationCountry,
        locationCity: contacts.locationCity,
      })
      .from(contacts)
      .where(inArray(contacts.id, ids))
      .orderBy(contacts.id)
      .for("update");
    const map = new Map(rows.map((r) => [r.id, r as unknown as ContactMergeRow]));
    return { survivor: map.get(survivorContactId), loser: map.get(loserContactId) };
  },

  /** Read-only pair load for the merge PREVIEW (no FOR UPDATE — a GET must not lock). RLS-scoped; a foreign
   *  id is absent. Same shape as lockAndLoadPair. */
  async loadPairForPreview(
    tx: Tx,
    survivorContactId: string,
    loserContactId: string,
  ): Promise<{ survivor?: ContactMergeRow; loser?: ContactMergeRow }> {
    const ids: string[] = [survivorContactId, loserContactId];
    const rows = await tx
      .select({
        id: contacts.id,
        tenantId: contacts.tenantId,
        workspaceId: contacts.workspaceId,
        deletedAt: contacts.deletedAt,
        mergedIntoContactId: contacts.mergedIntoContactId,
        accountId: contacts.accountId,
        ownerUserId: contacts.ownerUserId,
        masterPersonId: contacts.masterPersonId,
        isRevealed: contacts.isRevealed,
        revealedByUserId: contacts.revealedByUserId,
        revealedAt: contacts.revealedAt,
        lastActivityAt: contacts.lastActivityAt,
        customFields: contacts.customFields,
        fieldProvenance: contacts.fieldProvenance,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        jobTitle: contacts.jobTitle,
        seniorityLevel: contacts.seniorityLevel,
        department: contacts.department,
        locationCountry: contacts.locationCountry,
        locationCity: contacts.locationCity,
      })
      .from(contacts)
      .where(inArray(contacts.id, ids));
    const map = new Map(rows.map((r) => [r.id, r as unknown as ContactMergeRow]));
    return { survivor: map.get(survivorContactId), loser: map.get(loserContactId) };
  },

  /** Read-only child-impact counts for the merge preview (04 §6): how many live rows would re-point per table
   *  if the loser merged into a survivor. RLS-scoped via the caller's tx. Same table set as repointChildren's
   *  tallies (channels count LIVE rows). */
  async countLoserChildren(
    tx: Tx,
    loserId: string,
    scope: { workspaceId: string },
  ): Promise<Record<string, number>> {
    const rows = (await tx.execute(sql`
      SELECT
        (SELECT count(*) FROM contact_emails WHERE contact_id = ${loserId}::uuid AND deleted_at IS NULL) AS contact_emails,
        (SELECT count(*) FROM contact_phones WHERE contact_id = ${loserId}::uuid AND deleted_at IS NULL) AS contact_phones,
        (SELECT count(*) FROM list_members WHERE contact_id = ${loserId}::uuid) AS list_members,
        (SELECT count(*) FROM source_imports WHERE contact_id = ${loserId}::uuid) AS source_imports,
        (SELECT count(*) FROM activities WHERE contact_id = ${loserId}::uuid) AS activities,
        (SELECT count(*) FROM record_tags WHERE entity = 'contact' AND record_id = ${loserId}::uuid) AS record_tags,
        (SELECT count(*) FROM contact_reveals WHERE contact_id = ${loserId}::uuid) AS contact_reveals,
        (SELECT count(*) FROM suppression_list WHERE match_type = 'contact_id' AND contact_id = ${loserId}::uuid) AS suppression_list,
        (SELECT count(*) FROM consent_records WHERE contact_id = ${loserId}::uuid) AS consent_records,
        (SELECT count(*) FROM outreach_log WHERE contact_id = ${loserId}::uuid) AS outreach_log,
        (SELECT count(*) FROM email_thread WHERE contact_id = ${loserId}::uuid) AS email_thread,
        (SELECT count(*) FROM email_message WHERE contact_id = ${loserId}::uuid) AS email_message,
        (SELECT count(*) FROM email_event WHERE contact_id = ${loserId}::uuid) AS email_event,
        (SELECT count(*) FROM sales_nav_links WHERE contact_id = ${loserId}::uuid) AS sales_nav_links,
        (SELECT count(*) FROM scores WHERE contact_id = ${loserId}::uuid) AS scores,
        (SELECT count(*) FROM intent_signals WHERE contact_id = ${loserId}::uuid) AS intent_signals,
        (SELECT count(*) FROM contacts WHERE duplicate_of_contact_id = ${loserId}::uuid AND workspace_id = ${scope.workspaceId}::uuid) AS duplicate_markers
    `)) as unknown as Array<Record<string, number | string>>;
    const r = rows[0] ?? {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(r)) out[k] = Number(v) || 0;
    return out;
  },

  /** Per-workspace daily-cap gauge (04 §3.1): committed `contact.merge` audit events in this workspace since
   *  `since`. RLS-scoped via the caller's tx (the audit rows carry workspace_id). */
  async countMergesSince(tx: Tx, workspaceId: string, since: Date): Promise<number> {
    const rows = (await tx.execute(
      sql`SELECT count(*)::int AS n FROM audit_log
          WHERE action = 'contact.merge' AND workspace_id = ${workspaceId}::uuid AND occurred_at >= ${since.toISOString()}`,
    )) as unknown as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  },

  /** Apply the survivor write-set (04 §3.2 scalars/provenance/custom_fields + §1 blank-fills + §3.4 reveal
   *  adoption + last_activity max). Only the survivor row is touched here; channel demotion + child re-points
   *  are separate methods in the same tx. */
  async applySurvivorWrites(tx: Tx, survivorId: string, w: SurvivorWriteSet): Promise<void> {
    // scalarWrites carries the seven CONTACT_PROVENANCE_FIELDS (camelCase == the drizzle column props), so it
    // maps cleanly onto the contacts update set; the outer cast satisfies drizzle's typed set param without
    // leaking the dynamic index signature.
    const set = {
      ...w.scalarWrites,
      fieldProvenance: w.provenance,
      customFields: w.customFields,
      ...(w.accountId !== undefined ? { accountId: w.accountId } : {}),
      ...(w.ownerUserId !== undefined ? { ownerUserId: w.ownerUserId } : {}),
      ...(w.masterPersonId !== undefined ? { masterPersonId: w.masterPersonId } : {}),
      ...(w.isRevealed !== undefined ? { isRevealed: w.isRevealed } : {}),
      ...(w.revealedByUserId !== undefined ? { revealedByUserId: w.revealedByUserId } : {}),
      ...(w.revealedAt !== undefined ? { revealedAt: w.revealedAt } : {}),
      ...(w.lastActivityAt !== undefined ? { lastActivityAt: w.lastActivityAt } : {}),
      updatedAt: new Date(),
    } as unknown as Partial<typeof contacts.$inferInsert>;
    await tx.update(contacts).set(set).where(eq(contacts.id, survivorId));
  },

  /**
   * The COMPLETE Class-A re-point inventory (04 §3.4) — every live operational child of the loser moves to the
   * survivor (or collapses under a unique), in the caller's tx. Returns a per-table tally (the audit metadata +
   * the merge result). Channel demotion (05's §3.3 type-aware demote-to-secondary) is included.
   */
  async repointChildren(
    tx: Tx,
    loserId: string,
    survivorId: string,
    scope: { workspaceId: string },
  ): Promise<Record<string, number>> {
    const t: Record<string, number> = {};
    const now = new Date();

    // ── Channels (05 §3.3): demote-to-secondary. Emails are ws-value-unique (05 §2.2) ⇒ survivor cannot hold
    //    the loser's email value ⇒ a plain re-point never collides on either unique; is_primary=false so the
    //    survivor's primary + its flat cache are untouched (CH-INV-1 preserved, no cache rewrite — 04 §3.3).
    t.contact_emails = n(
      await tx
        .update(contactEmails)
        .set({ contactId: survivorId, isPrimary: false, updatedAt: now })
        .where(and(eq(contactEmails.contactId, loserId), isNull(contactEmails.deletedAt)))
        .returning({ id: contactEmails.id }),
    );

    // Phones are per-CONTACT unique only (shared HQ lines legal): a loser phone whose blind_index already lives
    // on the survivor collapses — soft-delete it BUT still re-point contact_id to the survivor so NO row
    // references the loser (T1). Non-colliding loser phones demote + re-point.
    const survivorPhoneKeys = await tx
      .select({ blindIndex: contactPhones.blindIndex })
      .from(contactPhones)
      .where(and(eq(contactPhones.contactId, survivorId), isNull(contactPhones.deletedAt)));
    const loserPhones = await tx
      .select({ id: contactPhones.id, blindIndex: contactPhones.blindIndex })
      .from(contactPhones)
      .where(and(eq(contactPhones.contactId, loserId), isNull(contactPhones.deletedAt)));
    const survivorKeySet = survivorPhoneKeys.map((r) => Buffer.from(r.blindIndex).toString("hex"));
    const collideIds: string[] = [];
    const moveIds: string[] = [];
    for (const p of loserPhones) {
      if (survivorKeySet.includes(Buffer.from(p.blindIndex).toString("hex"))) collideIds.push(p.id);
      else moveIds.push(p.id);
    }
    if (collideIds.length > 0) {
      await tx
        .update(contactPhones)
        .set({ contactId: survivorId, isPrimary: false, deletedAt: now, updatedAt: now })
        .where(inArray(contactPhones.id, collideIds));
    }
    if (moveIds.length > 0) {
      await tx
        .update(contactPhones)
        .set({ contactId: survivorId, isPrimary: false, updatedAt: now })
        .where(inArray(contactPhones.id, moveIds));
    }
    t.contact_phones = moveIds.length;

    // ── list_members (unique (list_id, contact_id)): a list holding BOTH keeps one membership (union). Delete
    //    the loser's rows in lists the survivor is already in; re-point the rest.
    const survivorLists = await tx
      .select({ listId: listMembers.listId })
      .from(listMembers)
      .where(eq(listMembers.contactId, survivorId));
    const survivorListIds = survivorLists.map((r) => r.listId);
    if (survivorListIds.length > 0) {
      await tx
        .delete(listMembers)
        .where(
          and(eq(listMembers.contactId, loserId), inArray(listMembers.listId, survivorListIds)),
        );
    }
    t.list_members = n(
      await tx
        .update(listMembers)
        .set({ contactId: survivorId })
        .where(eq(listMembers.contactId, loserId))
        .returning({ id: listMembers.id }),
    );

    // ── source_imports (lineage follows the person; the (workspace_id, content_hash) unique excludes
    //    contact_id ⇒ no collision).
    t.source_imports = n(
      await tx
        .update(sourceImports)
        .set({ contactId: survivorId })
        .where(eq(sourceImports.contactId, loserId))
        .returning({ id: sourceImports.id }),
    );

    // ── activities (the survivor's timeline becomes the union; no per-contact unique).
    t.activities = n(
      await tx
        .update(activities)
        .set({ contactId: survivorId })
        .where(eq(activities.contactId, loserId))
        .returning({ id: activities.id }),
    );

    // ── record_tags (G23 bare uuid, unique (tag_id, entity, record_id)): dedupe against the survivor's tag
    //    set, then re-point (entity='contact').
    const survivorTags = await tx
      .select({ tagId: recordTags.tagId })
      .from(recordTags)
      .where(and(eq(recordTags.entity, "contact"), eq(recordTags.recordId, survivorId)));
    const survivorTagIds = survivorTags.map((r) => r.tagId);
    if (survivorTagIds.length > 0) {
      await tx
        .delete(recordTags)
        .where(
          and(
            eq(recordTags.entity, "contact"),
            eq(recordTags.recordId, loserId),
            inArray(recordTags.tagId, survivorTagIds),
          ),
        );
    }
    t.record_tags = n(
      await tx
        .update(recordTags)
        .set({ recordId: survivorId })
        .where(and(eq(recordTags.entity, "contact"), eq(recordTags.recordId, loserId)))
        .returning({ id: recordTags.id }),
    );

    // ── contact_reveals (unique (workspace_id, contact_id, reveal_type)): NEVER double-charge — claims MOVE,
    //    never re-minted. Where the survivor already holds the same reveal_type claim, the loser's duplicate
    //    claim COLLAPSES (delete the redundant); the rest re-point. No new billable row is ever created.
    const survivorReveals = await tx
      .select({ revealType: contactReveals.revealType })
      .from(contactReveals)
      .where(eq(contactReveals.contactId, survivorId));
    const survivorRevealTypes = survivorReveals.map((r) => r.revealType);
    if (survivorRevealTypes.length > 0) {
      await tx
        .delete(contactReveals)
        .where(
          and(
            eq(contactReveals.contactId, loserId),
            inArray(contactReveals.revealType, survivorRevealTypes),
          ),
        );
    }
    t.contact_reveals = n(
      await tx
        .update(contactReveals)
        .set({ contactId: survivorId })
        .where(eq(contactReveals.contactId, loserId))
        .returning({ id: contactReveals.id }),
    );

    // ── suppression_list (match_type='contact_id'): suppression is UNBYPASSABLE (DM7) — a suppressed loser
    //    must keep suppressing the merged record. Re-point (no strict unique; belt-and-braces).
    t.suppression_list = n(
      await tx
        .update(suppressionList)
        .set({ contactId: survivorId })
        .where(and(eq(suppressionList.matchType, "contact_id"), eq(suppressionList.contactId, loserId)))
        .returning({ id: suppressionList.id }),
    );

    // ── consent_records (consent history follows the person; no per-contact unique).
    t.consent_records = n(
      await tx
        .update(consentRecords)
        .set({ contactId: survivorId })
        .where(eq(consentRecords.contactId, loserId))
        .returning({ id: consentRecords.id }),
    );

    // ── outreach_log (unique (sequence_id, contact_id)): a sequence enrolling BOTH keeps the survivor's
    //    enrollment — delete the loser's rows in sequences the survivor is already in; re-point the rest.
    const survivorSeqs = await tx
      .select({ sequenceId: outreachLog.sequenceId })
      .from(outreachLog)
      .where(eq(outreachLog.contactId, survivorId));
    const survivorSeqIds = survivorSeqs.map((r) => r.sequenceId);
    if (survivorSeqIds.length > 0) {
      await tx
        .delete(outreachLog)
        .where(
          and(eq(outreachLog.contactId, loserId), inArray(outreachLog.sequenceId, survivorSeqIds)),
        );
    }
    t.outreach_log = n(
      await tx
        .update(outreachLog)
        .set({ contactId: survivorId })
        .where(eq(outreachLog.contactId, loserId))
        .returning({ id: outreachLog.id }),
    );

    // ── email_thread / email_message / email_event (contact_id SET NULL; no per-contact unique — re-point
    //    wholesale so the survivor's engagement history is the union).
    t.email_thread = n(
      await tx
        .update(emailThread)
        .set({ contactId: survivorId })
        .where(eq(emailThread.contactId, loserId))
        .returning({ id: emailThread.id }),
    );
    t.email_message = n(
      await tx
        .update(emailMessage)
        .set({ contactId: survivorId })
        .where(eq(emailMessage.contactId, loserId))
        .returning({ id: emailMessage.id }),
    );
    t.email_event = n(
      await tx
        .update(emailEvent)
        .set({ contactId: survivorId })
        .where(eq(emailEvent.contactId, loserId))
        .returning({ id: emailEvent.id }),
    );

    // ── sales_nav_links (contact_id SET NULL; re-point).
    t.sales_nav_links = n(
      await tx
        .update(salesNavLinks)
        .set({ contactId: survivorId })
        .where(eq(salesNavLinks.contactId, loserId))
        .returning({ id: salesNavLinks.id }),
    );

    // ── scores / intent_signals (keep both histories; survivor's priority_score cache recomputes next pass).
    t.scores = n(
      await tx
        .update(scores)
        .set({ contactId: survivorId })
        .where(eq(scores.contactId, loserId))
        .returning({ id: scores.id }),
    );
    t.intent_signals = n(
      await tx
        .update(intentSignals)
        .set({ contactId: survivorId })
        .where(eq(intentSignals.contactId, loserId))
        .returning({ id: intentSignals.id }),
    );

    // ── Dedup markers pointing AT the loser (04 §3.4): re-point to the survivor (no dangling suggestions).
    //    The loser's OWN duplicate_of marker is irrelevant — it tombstones and drops out of dedup re-derivation
    //    (listForDedup excludes deleted_at). scope.workspaceId is belt-and-braces atop RLS.
    t.duplicate_markers = n(
      await tx
        .update(contacts)
        .set({ duplicateOfContactId: survivorId })
        .where(
          and(
            eq(contacts.duplicateOfContactId, loserId),
            eq(contacts.workspaceId, scope.workspaceId),
          ),
        )
        .returning({ id: contacts.id }),
    );

    return t;
  },

  /**
   * Tombstone the loser (04 §3.4): soft-delete + the irreversible merged_into/merged_at pointers + PII nulled
   * (safe — every channel value now lives on the survivor's child rows). Nulling the encrypted PII + the
   * identity dedup keys RELEASES them (email blind index / linkedin / sales-nav uniques) so the survivor (or a
   * future contact) may hold them. Keeps exactly one tombstone semantic in the table (the DSAR posture).
   */
  async tombstoneLoser(tx: Tx, loserId: string, survivorId: string): Promise<void> {
    const now = new Date();
    await tx
      .update(contacts)
      .set({
        deletedAt: now,
        mergedIntoContactId: survivorId,
        mergedAt: now,
        // PII + identity keys nulled (values now live on the survivor's children; keys released).
        firstName: null,
        lastName: null,
        emailEnc: null,
        emailBlindIndex: null,
        emailDomain: null,
        phoneEnc: null,
        linkedinUrl: null,
        linkedinPublicId: null,
        salesNavProfileUrl: null,
        salesNavLeadId: null,
        updatedAt: now,
      })
      .where(eq(contacts.id, loserId));
  },

  /** Write the contact.merge audit event IN-TX (04 §4) and return its id (support's reconstruction handle).
   *  metadata = survivor id, loser id, per-field decision set, the loser's field_provenance map, re-point
   *  tallies per child table — reconstructable from audit alone. */
  async recordMergeEvent(
    tx: Tx,
    e: {
      tenantId: string;
      workspaceId: string;
      actorUserId: string | null;
      survivorContactId: string;
      loserContactId: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<string> {
    const rows = await tx
      .insert(auditLog)
      .values({
        tenantId: e.tenantId,
        workspaceId: e.workspaceId,
        actorUserId: e.actorUserId,
        action: "contact.merge",
        entityType: "contact",
        entityId: e.survivorContactId,
        metadata: e.metadata,
      })
      .returning({ id: auditLog.id });
    return rows[0]!.id;
  },
};
