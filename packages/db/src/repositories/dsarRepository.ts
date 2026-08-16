// dsarRepository.ts — data access for the platform-owned dsar_requests workflow (compliance domain,
// 08 §4). Intake runs on the base/system path (the public form carries no tenant session); processing and
// status transitions run under the privileged role — rls/compliance.sql denies the app role entirely.

import { eq, sql } from "drizzle-orm";
import { type Tx, db } from "../client.ts";
import { dsarRequests } from "../schema/compliance.ts";

export interface DsarCreateInput {
  requestType: "access" | "delete" | "rectify";
  subjectEmailEnc: Uint8Array;
  subjectEmailBlindIndex: Uint8Array;
}

export interface DsarRow {
  id: string;
  requestType: string;
  status: string;
  scopeReport: unknown;
  requestedAt: Date;
  completedAt: Date | null;
  /**
   * The subject's HMAC dedup/DSAR key, stored at intake.
   *
   * Returned so the fan-out can work from the ROW rather than from a plaintext email handed in by its caller.
   * That is what keeps the subject's address out of the job payload, the BullMQ job log and the dead-letter
   * record — a DSAR pipeline that leaks the subject's email into Redis while erasing them from Postgres is
   * the wrong shape however well the erasure itself works.
   */
  subjectEmailBlindIndex: Uint8Array;
  /** The ≤72h SLA deadline (09 "automated SLA ≤72h"). Stamped at intake; never moved by a status change. */
  dueAt: Date;
}

/** A breached-SLA row. Ids and timings only — the breach probe must never carry the subject. */
export interface DsarOverdueRow {
  id: string;
  requestType: string;
  status: string;
  requestedAt: Date;
  dueAt: Date;
}

export const dsarRequestRepository = {
  /** Public intake (system path): the request exists before any verification. */
  async create(input: DsarCreateInput): Promise<string> {
    const rows = await db.insert(dsarRequests).values(input).returning({ id: dsarRequests.id });
    return rows[0]!.id;
  },

  async getById(tx: Tx, id: string): Promise<DsarRow | null> {
    const rows = await tx
      .select({
        id: dsarRequests.id,
        requestType: dsarRequests.requestType,
        status: dsarRequests.status,
        scopeReport: dsarRequests.scopeReport,
        requestedAt: dsarRequests.requestedAt,
        completedAt: dsarRequests.completedAt,
        subjectEmailBlindIndex: dsarRequests.subjectEmailBlindIndex,
        dueAt: sql<Date>`coalesce(${dsarRequests.dueAt}, ${dsarRequests.requestedAt} + interval '72 hours')`,
      })
      .from(dsarRequests)
      .where(eq(dsarRequests.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    // dueAt comes back through a raw `sql` expression, which carries no column type for the driver to map,
    // so it can arrive as a string. Normalised here rather than at each call site — a Date-typed field that
    // is sometimes a string is the kind of thing that only fails once it reaches arithmetic.
    return { ...row, dueAt: new Date(row.dueAt) };
  },

  /**
   * Requests whose ≤72h clock has run out and that are not finished.
   *
   * The whole point of an SLA is that missing it is VISIBLE. A deadline column nothing queries is a comment
   * with a type. This is the query the breach probe runs; it returns ids and timings only, never the subject.
   */
  async findOverdue(tx: Tx, now: Date, limit = 100): Promise<DsarOverdueRow[]> {
    const rows = await tx.execute(
      sql`SELECT id, request_type, status, requested_at,
                 coalesce(due_at, requested_at + interval '72 hours') AS due_at
            FROM dsar_requests
           WHERE status NOT IN ('completed','rejected')
             AND coalesce(due_at, requested_at + interval '72 hours') < ${now.toISOString()}::timestamptz
           ORDER BY due_at ASC
           LIMIT ${limit}`,
    );
    return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      requestType: r.request_type as string,
      status: r.status as string,
      requestedAt: new Date(r.requested_at as string | Date),
      dueAt: new Date(r.due_at as string | Date),
    }));
  },

  async setStatus(
    tx: Tx,
    id: string,
    status: "verifying" | "processing" | "completed" | "rejected",
    patch: { scopeReport?: unknown; verifiedAt?: Date; completedAt?: Date } = {},
  ): Promise<void> {
    await tx
      .update(dsarRequests)
      .set({ status, ...patch })
      .where(eq(dsarRequests.id, id));
  },
};

// ── The cross-workspace fan-out queries (08 §4, H6) — PRIVILEGED-tx only (withPrivilegedTx) ────────────

export interface SubjectCopy {
  contactId: string;
  tenantId: string;
  workspaceId: string;
  isRevealed: boolean;
  deletedAt: Date | null;
}

export const dsarFanoutRepository = {
  /** Every per-workspace copy of the subject, across ALL tenants (the find-everywhere enumeration). */
  async findCopies(tx: Tx, emailBlindIndex: Uint8Array): Promise<SubjectCopy[]> {
    const rows = (await tx.execute(sql`
      SELECT id AS contact_id, tenant_id, workspace_id, is_revealed, deleted_at
      FROM contacts WHERE email_blind_index = ${emailBlindIndex}
    `)) as unknown as Array<{
      contact_id: string;
      tenant_id: string;
      workspace_id: string;
      is_revealed: boolean;
      deleted_at: Date | null;
    }>;
    return rows.map((r) => ({
      contactId: r.contact_id,
      tenantId: r.tenant_id,
      workspaceId: r.workspace_id,
      isRevealed: r.is_revealed,
      deletedAt: r.deleted_at,
    }));
  },

  /** Tombstone one copy: deleted_at + every PII column nulled, incl. the blind index (erasure forgets the key). */
  async tombstone(tx: Tx, contactId: string): Promise<void> {
    await tx.execute(sql`
      UPDATE contacts SET deleted_at = now(), first_name = NULL, last_name = NULL,
        email_enc = NULL, email_blind_index = NULL, email_domain = NULL,
        phone_enc = NULL, linkedin_url = NULL, linkedin_public_id = NULL,
        sales_nav_profile_url = NULL, sales_nav_lead_id = NULL
      WHERE id = ${contactId}
    `);
  },

  /** Purge the copy's dependents (08 §4.2): provenance, reveal events, consent rows, and LIST MEMBERSHIP.
   *  list_members is swept here EXPLICITLY (list-plan/08 §5.2 step 3, 07 gap #7): the fan-out TOMBSTONES the
   *  contact (deleted_at + nulled PII) rather than DELETEing the row, so the `list_members.contact_id` ON
   *  DELETE CASCADE never fires — without this sweep an erased person's memberships would linger and a list
   *  would still reference them. Removing the join row drops no PII of its own, so it is a clean removal, not
   *  a tombstone. */
  async purgeDependents(tx: Tx, contactIds: string[]): Promise<void> {
    if (contactIds.length === 0) return;
    // Pass ids as a Postgres array LITERAL ('{a,b}') — drizzle's sql template does not parameterize JS
    // arrays as SQL arrays.
    const ids = `{${contactIds.join(",")}}`;
    await tx.execute(sql`DELETE FROM source_imports WHERE contact_id = ANY(${ids}::uuid[])`);
    await tx.execute(sql`DELETE FROM contact_reveals WHERE contact_id = ANY(${ids}::uuid[])`);
    await tx.execute(sql`DELETE FROM consent_records WHERE contact_id = ANY(${ids}::uuid[])`);
    await tx.execute(sql`DELETE FROM list_members WHERE contact_id = ANY(${ids}::uuid[])`);
  },

  /** The verification scan (08 §4.2 step 6): zero residual PII anywhere, or the job must not complete. */
  async scanResiduals(
    tx: Tx,
    emailBlindIndex: Uint8Array,
    contactIds: string[],
  ): Promise<{ liveCopies: number; piiOnTombstones: number; dependents: number }> {
    const [live] = (await tx.execute(sql`
      SELECT count(*)::int AS n FROM contacts
      WHERE email_blind_index = ${emailBlindIndex} AND deleted_at IS NULL
    `)) as unknown as Array<{ n: number }>;
    const idList = contactIds.length > 0 ? contactIds : ["00000000-0000-0000-0000-000000000000"];
    const ids = `{${idList.join(",")}}`; // array literal — see purgeDependents
    const [pii] = (await tx.execute(sql`
      SELECT count(*)::int AS n FROM contacts
      WHERE id = ANY(${ids}::uuid[])
        AND (email_enc IS NOT NULL OR phone_enc IS NOT NULL OR first_name IS NOT NULL
             OR last_name IS NOT NULL OR linkedin_url IS NOT NULL)
    `)) as unknown as Array<{ n: number }>;
    // list_members is part of the dependent residual count (list-plan/08 §5.2 step 6): the job must NOT
    // report `completed` while any erased subject's list membership lingers.
    //
    // crm_record_links is counted here too (crm-sync 00 §7.6), and it is the one residual that lives
    // OUTSIDE TruePoint: a surviving link means the subject still exists in the customer's CRM, so a DSAR
    // that reported `completed` would be claiming an erasure that did not happen. Note it is deliberately
    // NOT in purgeDependents — the outbound erase job needs the row's crm_record_id to tell the CRM WHAT to
    // delete, and only deletes the row once the provider confirms. Purging it here would destroy the
    // pointer and strand the subject in the CRM permanently, with the DSAR reporting success.
    const [dep] = (await tx.execute(sql`
      SELECT (SELECT count(*) FROM source_imports WHERE contact_id = ANY(${ids}::uuid[]))::int
           + (SELECT count(*) FROM contact_reveals WHERE contact_id = ANY(${ids}::uuid[]))::int
           + (SELECT count(*) FROM consent_records WHERE contact_id = ANY(${ids}::uuid[]))::int
           + (SELECT count(*) FROM list_members WHERE contact_id = ANY(${ids}::uuid[]))::int
           + (SELECT count(*) FROM crm_record_links WHERE contact_id = ANY(${ids}::uuid[]))::int AS n
    `)) as unknown as Array<{ n: number }>;
    return {
      liveCopies: Number(live?.n ?? 0),
      piiOnTombstones: Number(pii?.n ?? 0),
      dependents: Number(dep?.n ?? 0),
    };
  },

  /** Per-copy data footprint for the access report (08 §4.1). */
  async copyFootprint(
    tx: Tx,
    contactId: string,
  ): Promise<{ sourceImports: number; reveals: number; consentRecords: number }> {
    const [counts] = (await tx.execute(sql`
      SELECT (SELECT count(*) FROM source_imports WHERE contact_id = ${contactId})::int AS imports,
             (SELECT count(*) FROM contact_reveals WHERE contact_id = ${contactId})::int AS reveals,
             (SELECT count(*) FROM consent_records WHERE contact_id = ${contactId})::int AS consents
    `)) as unknown as Array<{ imports: number; reveals: number; consents: number }>;
    return {
      sourceImports: Number(counts?.imports ?? 0),
      reveals: Number(counts?.reveals ?? 0),
      consentRecords: Number(counts?.consents ?? 0),
    };
  },

  /** Global-scope suppression so no source re-imports the subject and no send can reach them (08 §4.2 step 4).
   *
   *  IDEMPOTENT. deleteFanout is re-runnable by design and now adds the suppression unconditionally rather
   *  than only when live copies were found, so without this guard every re-run would stack another identical
   *  global row — turning the one list that must stay readable by a human into noise. There is no unique
   *  constraint to lean on (0094's partial indexes are for matching, not uniqueness), so the guard is explicit. */
  async addGlobalSuppression(tx: Tx, emailBlindIndex: Uint8Array, reason: string): Promise<void> {
    await tx.execute(sql`
      INSERT INTO suppression_list (scope, match_type, email_blind_index, reason)
      SELECT 'global', 'email', ${emailBlindIndex}, ${reason}
       WHERE NOT EXISTS (
         SELECT 1 FROM suppression_list
          WHERE scope = 'global' AND match_type = 'email' AND email_blind_index = ${emailBlindIndex}
       )
    `);
  },

  // ── LAYER 0 (Phase 5: "erasure = tombstone event + graph reprocess") ────────────────────────────────────
  //
  // Everything above erases the OVERLAY. The golden graph was untouched, and that is the hole: the overlay
  // copies are per-workspace convenience, while master_persons is the shared node every future import,
  // enrichment and reveal resolves against. Erasing only the overlay means the next import of the same
  // person re-mints a live contact from a golden row that still exists — the subject reappears, and the
  // global suppression row is all that stands between them and being sold again.
  //
  // The mechanism is SUPPRESSION, not deletion. master_persons.is_suppressed already exists and its comment
  // already claims "set by the DSAR fan-out"; until now nothing set it. Deleting the golden row instead
  // would be worse in two ways: it orphans every overlay bridge pointing at it, and it destroys the only
  // record that this identity must never be re-minted — so the next crawl would recreate it clean.

  /** The golden persons this subject resolves to, via the shared blind index. */
  async findMasterPersons(tx: Tx, emailBlindIndex: Uint8Array): Promise<string[]> {
    const rows = (await tx.execute(sql`
      SELECT DISTINCT master_person_id FROM master_emails WHERE email_blind_index = ${emailBlindIndex}
    `)) as unknown as Array<{ master_person_id: string }>;
    return rows.map((r) => r.master_person_id);
  },

  /**
   * Suppress the golden node and drop the channel facets the subject asked to be forgotten.
   *
   * The blind index goes too. It is a dedup key, not a contact value — but it is derived from the email, so
   * keeping it would leave the graph able to recognise the subject on sight forever. The suppression_list row
   * added by step 4 keeps that recognition where it belongs: in the deny list, not in the golden record.
   *
   * Returns the number of persons suppressed so the caller can report it and the residual scan can check it.
   */
  async suppressMasterPersons(tx: Tx, masterPersonIds: string[]): Promise<number> {
    if (masterPersonIds.length === 0) return 0;
    const ids = `{${masterPersonIds.join(",")}}`; // array literal — see purgeDependents
    await tx.execute(sql`DELETE FROM master_emails WHERE master_person_id = ANY(${ids}::uuid[])`);
    await tx.execute(sql`DELETE FROM master_phones WHERE master_person_id = ANY(${ids}::uuid[])`);
    // PERSON-SUBJECT SIGNALS (master_signals, migration 0103). A dated career event is personal data even
    // though it carries no contact value — applyMigrations says so at the REVOKE, and cascade 1 §7 states the
    // governing rule outright: "the right to erasure beats the append-only principle for personal data, full
    // stop." Deleted here, in the SAME privileged transaction as the channels above, so a partial erasure
    // cannot commit.
    //
    // SCOPED BY subject_type: master_signals is polymorphic, and a company-subject row is a fact about a
    // COMPANY (a funding round, an acquisition) that no person may erase. Dropping the discriminator would
    // silently delete company intelligence on every DSAR.
    //
    // Wired while the table is still EMPTY, which is the whole point: retrofitting erasure onto a populated
    // append-only store is the miserable case cascade 1 §7 warns about. Index-backed by
    // idx_master_signals_subject (subject_type, subject_id, observed_at).
    await tx.execute(sql`
      DELETE FROM master_signals
       WHERE subject_type = 'person'
         AND subject_id = ANY(${ids}::uuid[])`);
    // EXTERNAL IDENTIFIERS (master_person_identifiers, 0104; fed by the linkedin_api landing since 0113).
    // Public profile handles keyed to a person are personal data AND a recognition surface: a surviving
    // (id_type, id_value) row would re-link the subject on the very next ingest of the same profile —
    // the same argument as the email blind index above. Recognition belongs in the deny list.
    await tx.execute(
      sql`DELETE FROM master_person_identifiers WHERE master_person_id = ANY(${ids}::uuid[])`,
    );
    // SKILLS + LANGUAGES (0116) — a skill/language list keyed to a person is personal data, same class as
    // the identifier rows above; deleted in the same privileged transaction.
    await tx.execute(
      sql`DELETE FROM master_person_skills WHERE master_person_id = ANY(${ids}::uuid[])`,
    );
    await tx.execute(
      sql`DELETE FROM master_person_languages WHERE master_person_id = ANY(${ids}::uuid[])`,
    );
    // STINT FREE-TEXT (0112): position location/description are subject-authored prose; the stint itself
    // (an anonymous node held a role at a company) survives as business fact, its self-description does not.
    await tx.execute(sql`
      UPDATE master_employment SET location = NULL, description = NULL
       WHERE master_person_id = ANY(${ids}::uuid[])
         AND (location IS NOT NULL OR description IS NOT NULL)`);
    const rows = (await tx.execute(sql`
      UPDATE master_persons
         SET is_suppressed = true, has_email = false, has_phone = false,
             full_name = NULL, first_name = NULL, last_name = NULL, linkedin_public_id = NULL,
             headline = NULL, summary = NULL, location_raw = NULL
       WHERE id = ANY(${ids}::uuid[])
       RETURNING id
    `)) as unknown as Array<{ id: string }>;
    return rows.length;
  },

  /**
   * Residual scan for Layer 0: any golden node still reachable by this subject's key, or reachable and not
   * suppressed. Counted into the completion gate so a DSAR cannot report `completed` while the shared graph
   * still holds the subject — the exact false claim the overlay-only fan-out was making.
   *
   * `masterPersonIds` are the nodes the fan-out resolved and suppressed. They are passed in rather than
   * re-derived because suppression has already removed the blind index that found them — after the fact there
   * is deliberately no way back from the subject's key to the node, which is the point of deleting it.
   *
   * A SCAN THAT DOES NOT COUNT A STORE CANNOT PROVE ANYTHING ABOUT IT. Person-subject signals were erased
   * above but were not counted here, which meant a DSAR could report zero residuals while those rows
   * survived — a false completion claim, which is worse than the rows, because it is the completion gate that
   * the ≤72h A-02 SLA is measured against.
   */
  async scanMasterResiduals(
    tx: Tx,
    emailBlindIndex: Uint8Array,
    masterPersonIds: string[] = [],
  ): Promise<number> {
    // No resolved nodes ⇒ nothing to have missed; matching nothing is correct rather than matching everything.
    const ids = `{${masterPersonIds.join(",")}}`;
    const signalResidual =
      masterPersonIds.length === 0
        ? sql`0`
        : sql`(SELECT count(*) FROM master_signals
                WHERE subject_type = 'person' AND subject_id = ANY(${ids}::uuid[]))`;
    // A scan that does not count a store cannot prove anything about it (the rule above) — the identifier
    // rows the 0113 landing writes are counted here for the same reason the signals are.
    const identifierResidual =
      masterPersonIds.length === 0
        ? sql`0`
        : sql`(SELECT count(*) FROM master_person_identifiers
                WHERE master_person_id = ANY(${ids}::uuid[]))
            + (SELECT count(*) FROM master_person_skills
                WHERE master_person_id = ANY(${ids}::uuid[]))
            + (SELECT count(*) FROM master_person_languages
                WHERE master_person_id = ANY(${ids}::uuid[]))`;
    const [r] = (await tx.execute(sql`
      SELECT ((SELECT count(*) FROM master_emails WHERE email_blind_index = ${emailBlindIndex})
            + (SELECT count(*) FROM master_persons p
                WHERE p.is_suppressed = false
                  AND EXISTS (SELECT 1 FROM master_emails e
                               WHERE e.master_person_id = p.id
                                 AND e.email_blind_index = ${emailBlindIndex}))
            + ${signalResidual}
            + ${identifierResidual})::int AS n
    `)) as unknown as Array<{ n: number }>;
    return Number(r?.n ?? 0);
  },

  /**
   * The tombstone provenance event (06-roadmap Phase 5, "erasure = tombstone event").
   *
   * Appended rather than deleting the subject's history, because provenance_event is append-only by trigger
   * and because the erasure itself is a fact the record needs: a projector replaying the stream has to learn
   * that the tail is void, and a deleted history would simply replay into a live person again. The payload
   * carries the request id and NOTHING about the subject — a tombstone that quoted what was erased would be
   * a copy of the thing it erases.
   *
   * No idempotency guard is needed and none is added: suppressMasterPersons deletes the master_emails rows
   * that findMasterPersons resolves through, so a re-run finds no persons and never reaches here.
   */
  async appendTombstoneEvent(tx: Tx, masterPersonId: string, requestId: string): Promise<void> {
    await tx.execute(sql`
      INSERT INTO provenance_event
        (entity_type, entity_id, field, action, source_type, lawful_basis, payload, acceptance_state)
      VALUES ('person', ${masterPersonId}, '*', 'tombstone', 'user_edit', 'consent',
              ${JSON.stringify({ requestId })}::jsonb, 'accepted')
    `);
  },
};
