// contactRepository.ts — data access for `contacts` (reveal/contacts domain). Holds the per-workspace dedup
// lookups + writes used by the import pipeline (tx-aware, composed inside one withTenantTx), plus the
// self-contained masked list the API/search surfaces read. PII (email/phone) is stored encrypted; this
// layer never returns plaintext — callers see only the non-PII facets until reveal (M3). 03 §5/§9.

import {
  ageDaysSince,
  computeContactDataQuality,
  type ContactChannelSummaries,
  type FieldProvenanceMap,
  type MaskedContact,
  type PhoneLineType,
  reverifyCutoff,
  type WorkspaceDataQuality,
} from "@leadwolf/types";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type TenantScope, type Tx, db, withTenantTx } from "../client.ts";
import { accounts, contacts } from "../schema/contacts.ts";
import { contactChannelRepository } from "./contactChannelRepository.ts";

/** S-CH4 read opt threaded from the caller-evaluated composed read gate (05 §6). Default off ⇒ the email
 *  dedup rung + masked projections resolve from the flat columns, byte-identical to the pre-S-CH4 path. */
export interface ContactReadOpts {
  channelsFromChild?: boolean;
}

/** A within-workspace duplicate contact + the canonical it was auto-pointed at (dedup review, G09). NAMES ONLY —
 *  no encrypted email/phone; both sides are same-workspace (RLS-scoped). */
export interface DuplicatePairRow {
  duplicateId: string;
  duplicateFirstName: string | null;
  duplicateLastName: string | null;
  duplicateCreatedAt: Date;
  canonicalId: string;
  canonicalFirstName: string | null;
  canonicalLastName: string | null;
}

/** A top-priority lead for the Home dashboard — FACETS ONLY (no encrypted email/phone). Mirrors HotLead. */
export interface HotLeadRow {
  id: string;
  firstName: string | null;
  lastName: string | null;
  jobTitle: string | null;
  emailDomain: string | null;
  priorityScore: number;
  outreachStatus: string;
  isRevealed: boolean;
}

/** The dedup keys, in priority order: a match on any identifies the same person within the workspace. */
export interface DedupKeys {
  emailBlindIndex?: Uint8Array;
  linkedinPublicId?: string;
  salesNavLeadId?: string;
}

/** The writable columns the import pipeline computes for a contact. PII arrives already encrypted. */
export interface ContactWriteValues {
  tenantId: string;
  workspaceId: string;
  accountId?: string | null;
  // overlay → Layer-0 golden bridge (ADR-0021); set by import MATCH-AGAINST resolution. Nullable = in-flight ER
  // staging only (PLAN_00 C8); the FK referential check runs with table-owner privilege, so leadwolf_app can
  // link to a master_persons row it cannot itself read (the grant-off wall).
  masterPersonId?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  emailEnc?: Uint8Array | null;
  emailBlindIndex?: Uint8Array | null;
  emailDomain?: string | null;
  jobTitle?: string | null;
  seniorityLevel?: string | null;
  department?: string | null;
  phoneEnc?: Uint8Array | null;
  emailStatus?: string; // verification result (06 §9; NOT NULL column) — set by verify-on-reveal / enrichment
  phoneStatus?: string | null;
  phoneLineType?: string | null; // carrier line type (Twilio Lookup) — set by the phone verifier (01 §5.3)
  lastVerifiedAt?: Date | null; // when PII was last verified (list-plan/06 §3.3) — set by verify/enrich
  linkedinUrl?: string | null;
  linkedinPublicId?: string | null;
  salesNavProfileUrl?: string | null;
  salesNavLeadId?: string | null;
  locationCountry?: string | null;
  locationCity?: string | null;
  // Per-field provenance descriptor map (PLAN_03 §3.1); written by the enrichment/edit paths. Drizzle maps
  // this camelCase key → the `field_provenance` jsonb column. Empty {} default lives on the column.
  fieldProvenance?: FieldProvenanceMap;
}

/** Drop undefined keys so an UPDATE never overwrites an existing value with `undefined`. */
function definedOnly<T extends object>(v: T): Partial<T> {
  return Object.fromEntries(Object.entries(v).filter(([, val]) => val !== undefined)) as Partial<T>;
}

/** Hex key so a bytea blind index can index a JS Map (a Uint8Array can't — Map keys use object identity). */
function byteaKey(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

/** Non-PII per-contact signals the bulk spend-estimate reads (list-plan/06 §4.2). Presence flags + state
 *  only — never the encrypted PII. `emailStatus` is the verification grade (drives charge-only-valid). */
export interface EnrichEstimateSignal {
  id: string;
  hasEmail: boolean;
  hasPhone: boolean;
  isRevealed: boolean;
  emailStatus: string;
}

/** The minimal, non-PII row the dedup worker needs: identity fields for the match key + completeness signals
 *  for canonical selection. `hasPhone` is derived from the encrypted column (never the plaintext). */
export interface DedupContactRow {
  id: string;
  firstName: string | null;
  lastName: string | null;
  emailDomain: string | null;
  jobTitle: string | null;
  linkedinUrl: string | null;
  seniorityLevel: string | null;
  department: string | null;
  locationCountry: string | null;
  hasPhone: boolean;
  isRevealed: boolean;
  createdAt: Date;
}

/**
 * The minimal, NON-PII row the master-link backfill needs to re-resolve an EXISTING overlay contact through the
 * Phase-2′ resolver: the contact's own resolver keys (email blind index → linkedin) plus its account's
 * domain/name (the company resolver keys). The account fields are null when the contact has no `account_id`
 * (LEFT JOIN miss). `emailBlindIndex` is the raw bytea (HMAC of the normalized email), never the plaintext.
 */
export interface UnresolvedContactRow {
  id: string;
  emailBlindIndex: Uint8Array | null;
  emailDomain: string | null;
  linkedinPublicId: string | null;
  accountId: string | null;
  accountDomain: string | null;
  accountName: string | null;
}

/**
 * The minimal row the freshness re-verification loop needs to re-grade a REVEALED contact's channels: its id +
 * the ENCRYPTED email/phone (the worker decrypts to call the verifier — plaintext never leaves this layer) + the
 * current statuses. Only revealed, live, past-SLA rows are returned (the in-use freshness gate).
 */
export interface StaleRevealedRow {
  id: string;
  emailEnc: Uint8Array | null;
  phoneEnc: Uint8Array | null;
  emailStatus: string;
  phoneStatus: string | null;
}

/** The full `contacts` select row — the input the masked projection maps from. */
type ContactRow = typeof contacts.$inferSelect;

/**
 * Map a full `contacts` row → the masked, non-PII DTO the search/results + export surfaces read, INCLUDING the
 * derived Data Health badge (list-plan/06 §3.3): the 0–100 `computeContactDataQuality` score + freshness band
 * from the canonical single source in @leadwolf/types (the SAME composition as listRepository.toMaskedMember —
 * never re-derived). All inputs are non-PII present-flags + statuses + the last-verified age, so it is safe here.
 */
function toMaskedContact(r: ContactRow, channels?: ContactChannelSummaries): MaskedContact {
  const emailStatus = r.emailStatus as MaskedContact["emailStatus"];
  const phoneStatus = r.phoneStatus as MaskedContact["phoneStatus"];
  // S-CH4 gate-on (channels present): has_email/has_phone derive from live child-row counts ("∃ live value"
  // — identical to the flat derivation in steady state by CH-INV-1, correct for no-primary edges, and
  // secondaries count). dataHealth follows. Gate-off (channels absent) both are the flat-column presence,
  // byte-identical to the pre-S-CH4 projection.
  const hasEmail = channels ? channels.emailCount > 0 : r.emailEnc != null;
  const hasPhone = channels ? channels.phoneCount > 0 : r.phoneEnc != null;
  const lastVerifiedAt = r.lastVerifiedAt?.toISOString() ?? null;
  const dataHealth = computeContactDataQuality({
    hasName: r.firstName !== null || r.lastName !== null,
    hasEmail,
    hasPhone,
    hasTitle: r.jobTitle !== null,
    hasCompany: r.accountId !== null || r.emailDomain !== null,
    hasLocation: r.locationCountry !== null || r.locationCity !== null,
    hasLinkedin: r.linkedinPublicId !== null || r.linkedinUrl !== null,
    emailStatus,
    phoneStatus,
    ageDaysSinceVerified: ageDaysSince(lastVerifiedAt),
  });
  return {
    id: r.id,
    firstName: r.firstName,
    lastName: r.lastName,
    jobTitle: r.jobTitle,
    emailDomain: r.emailDomain,
    emailStatus,
    phoneStatus,
    phoneLineType: r.phoneLineType as PhoneLineType | null,
    hasEmail,
    hasPhone,
    seniorityLevel: r.seniorityLevel as MaskedContact["seniorityLevel"],
    department: r.department,
    locationCountry: r.locationCountry,
    locationCity: r.locationCity,
    outreachStatus: r.outreachStatus as MaskedContact["outreachStatus"],
    isRevealed: r.isRevealed,
    // Soft owner (the assignable "My prospects" dimension); falls back to the first-reveal owner for rows
    // not yet assigned/backfilled. Non-PII user FK.
    ownerUserId: r.ownerUserId ?? r.revealedByUserId,
    createdAt: r.createdAt.toISOString(),
    lastVerifiedAt,
    dataHealth,
    // Additive, gate-on only (05 §5): masked per-value channel summaries. ABSENT gate-off ⇒ byte-identical.
    ...(channels ? { channels } : {}),
  };
}

/** Overlay the masked rows with their batched channel summaries when the S-CH4 read gate is on (05 §5): ONE
 *  query per table for the whole page (no N+1). Gate-off ⇒ the rows pass through untouched, byte-identical. */
async function withChannelSummaries(
  tx: Tx,
  rows: ContactRow[],
  opts: ContactReadOpts,
): Promise<MaskedContact[]> {
  if (!opts.channelsFromChild || rows.length === 0) return rows.map((r) => toMaskedContact(r));
  const byId = await contactChannelRepository.channelSummariesForContacts(
    tx,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toMaskedContact(r, byId.get(r.id)));
}

export const contactRepository = {
  /**
   * A keyset-paged batch of EXISTING overlay contacts that still need master resolution: master_person_id IS
   * NULL and the row is live (deleted_at IS NULL). Selects the contact's own resolver keys plus its account's
   * domain/name via a LEFT JOIN to `accounts` (the account fields are null when the contact has no account_id).
   * Ordered by id ASC and keyset-paged on `cursor` (id > cursor; null = first page) so the backfill walks the
   * workspace in stable, bounded batches without OFFSET. RLS scopes this to ONE workspace via the caller's
   * withTenantTx GUC — there is no explicit workspace predicate here, isolation rides the tx (like assignOwner).
   * The bytea blind index is returned raw (Uint8Array), consistent with the email-key handling in
   * findByDedupKeys; never the plaintext email/phone.
   */
  async findUnresolvedForBackfill(
    tx: Tx,
    cursor: string | null,
    limit: number,
  ): Promise<UnresolvedContactRow[]> {
    const rows = await tx
      .select({
        id: contacts.id,
        emailBlindIndex: contacts.emailBlindIndex,
        emailDomain: contacts.emailDomain,
        linkedinPublicId: contacts.linkedinPublicId,
        accountId: contacts.accountId,
        accountDomain: accounts.domain,
        accountName: accounts.name,
      })
      .from(contacts)
      .leftJoin(accounts, eq(contacts.accountId, accounts.id))
      .where(
        and(
          isNull(contacts.masterPersonId),
          isNull(contacts.deletedAt),
          cursor === null ? undefined : gt(contacts.id, cursor),
        ),
      )
      .orderBy(asc(contacts.id))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      emailBlindIndex: r.emailBlindIndex ?? null,
      emailDomain: r.emailDomain,
      linkedinPublicId: r.linkedinPublicId,
      accountId: r.accountId,
      accountDomain: r.accountDomain,
      accountName: r.accountName,
    }));
  },

  /**
   * SYSTEM-LEVEL enumeration for the scheduled master-backfill sweep (PLAN_07 Stage B). Returns the
   * (tenantId, workspaceId) of every workspace that still holds unresolved (NULL master_person_id, live)
   * contacts, so the sweep can enqueue a per-workspace backfill. Runs on the OWNER connection (NO leadwolf_app
   * role drop → it must see EVERY workspace) because the set is intentionally cross-workspace; it returns ONLY
   * non-PII ids (never a contact value). NOT reachable from a tenant request — only the leader-locked sweep
   * worker calls it. Backed by idx_contacts_unresolved; `limit`-capped so one sweep can't fan out unbounded.
   */
  async listWorkspacesWithUnresolvedContacts(
    limit = 1000,
  ): Promise<Array<{ tenantId: string; workspaceId: string }>> {
    const rows = (await db.execute(
      sql`SELECT DISTINCT tenant_id, workspace_id FROM contacts
          WHERE master_person_id IS NULL AND deleted_at IS NULL
          LIMIT ${limit}`,
    )) as unknown as Array<{ tenant_id: string; workspace_id: string }>;
    return rows.map((r) => ({ tenantId: r.tenant_id, workspaceId: r.workspace_id }));
  },

  /**
   * A keyset-paged batch of REVEALED, live contacts whose last_verified_at is past the freshness `cutoff` (or
   * never set) — the freshness re-verification loop's in-use selection (22 §3/§4, ADR-0025). Returns the
   * ENCRYPTED email/phone (the worker decrypts to call the verifier; plaintext never leaves this layer) plus the
   * current statuses. RLS scopes this to ONE workspace via the caller's withTenantTx GUC (no explicit workspace
   * predicate — isolation rides the tx, like findUnresolvedForBackfill). Ordered by id ASC and keyset-paged on
   * `cursor` (id > cursor; null = first page) so a sweep walks the workspace in stable, bounded batches.
   */
  async findStaleRevealedForReverify(
    tx: Tx,
    cutoff: Date,
    cursor: string | null,
    limit: number,
  ): Promise<StaleRevealedRow[]> {
    const rows = await tx
      .select({
        id: contacts.id,
        emailEnc: contacts.emailEnc,
        phoneEnc: contacts.phoneEnc,
        emailStatus: contacts.emailStatus,
        phoneStatus: contacts.phoneStatus,
      })
      .from(contacts)
      .where(
        and(
          eq(contacts.isRevealed, true),
          isNull(contacts.deletedAt),
          or(isNull(contacts.lastVerifiedAt), lt(contacts.lastVerifiedAt, cutoff)),
          cursor === null ? undefined : gt(contacts.id, cursor),
        ),
      )
      .orderBy(asc(contacts.id))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      emailEnc: r.emailEnc ?? null,
      phoneEnc: r.phoneEnc ?? null,
      emailStatus: r.emailStatus,
      phoneStatus: r.phoneStatus,
    }));
  },

  /**
   * SYSTEM-LEVEL enumeration for the scheduled re-verification sweep (ADR-0025): the (tenantId, workspaceId) of
   * every workspace holding REVEALED, live contacts past the freshness `cutoff`, so the sweep can enqueue a
   * per-workspace re-verification. Runs on the OWNER connection (no leadwolf_app drop → sees EVERY workspace);
   * returns ONLY non-PII ids. NOT reachable from a tenant request — only the leader-locked sweep calls it.
   * `limit`-capped so one sweep can't fan out unbounded. Mirrors listWorkspacesWithUnresolvedContacts.
   */
  async listWorkspacesWithStaleRevealed(
    cutoff: Date,
    limit = 1000,
  ): Promise<Array<{ tenantId: string; workspaceId: string }>> {
    const rows = (await db.execute(
      sql`SELECT DISTINCT tenant_id, workspace_id FROM contacts
          WHERE is_revealed = true AND deleted_at IS NULL
            AND (last_verified_at IS NULL OR last_verified_at < ${cutoff})
          LIMIT ${limit}`,
    )) as unknown as Array<{ tenant_id: string; workspace_id: string }>;
    return rows.map((r) => ({ tenantId: r.tenant_id, workspaceId: r.workspace_id }));
  },

  /** Every workspace holding at least one live contact (system-level, non-PII, owner connection) — the Data
   *  Health snapshot sweep's fan-out enumeration. DISTINCT over the live rows; capped by `limit`. */
  async listWorkspacesWithContacts(
    limit = 1000,
  ): Promise<Array<{ tenantId: string; workspaceId: string }>> {
    const rows = (await db.execute(
      sql`SELECT DISTINCT tenant_id, workspace_id FROM contacts WHERE deleted_at IS NULL LIMIT ${limit}`,
    )) as unknown as Array<{ tenant_id: string; workspace_id: string }>;
    return rows.map((r) => ({ tenantId: r.tenant_id, workspaceId: r.workspace_id }));
  },

  /** Find an existing contact in the workspace by the first dedup key that hits (email → linkedin → sales-nav).
   *  S-CH4 (05 §6): gate-on the email rung retargets to `contact_emails.blind_index` (secondaries resolve too —
   *  the G15/G16 payoff), workspace-scoped; the §2.2 partial ws-unique guarantees ≤1 live row per key so
   *  precedence is preserved exactly. Gate-off (default) the rung reads `contacts.email_blind_index`,
   *  byte-identical. linkedin/sales-nav rungs are unchanged either way. */
  async findByDedupKeys(
    tx: Tx,
    workspaceId: string,
    keys: DedupKeys,
    opts: ContactReadOpts = {},
  ): Promise<{ id: string } | null> {
    if (keys.emailBlindIndex) {
      if (opts.channelsFromChild) {
        const hits = await contactChannelRepository.findContactIdsByEmailBlindIndexes(tx, workspaceId, [
          keys.emailBlindIndex,
        ]);
        if (hits[0]) return { id: hits[0].contactId };
      } else {
        const r = await tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(
            and(
              eq(contacts.workspaceId, workspaceId),
              eq(contacts.emailBlindIndex, keys.emailBlindIndex),
            ),
          )
          .limit(1);
        if (r[0]) return r[0];
      }
    }
    if (keys.linkedinPublicId) {
      const r = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.workspaceId, workspaceId),
            eq(contacts.linkedinPublicId, keys.linkedinPublicId),
          ),
        )
        .limit(1);
      if (r[0]) return r[0];
    }
    if (keys.salesNavLeadId) {
      const r = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.workspaceId, workspaceId),
            eq(contacts.salesNavLeadId, keys.salesNavLeadId),
          ),
        )
        .limit(1);
      if (r[0]) return r[0];
    }
    return null;
  },

  /**
   * Batched against-existing dedup for a whole import chunk (15-bulk-import-design §2). Returns one result per
   * input, index-aligned, resolving each by the SAME email → linkedin → sales-nav precedence as findByDedupKeys
   * (and, like it, NOT excluding soft-deleted/tombstoned rows — the dedup lookups intentionally match them, see
   * runImport.addLandedToList). This CANNOT be one ON CONFLICT: the identity ladder spans THREE partial-unique
   * indexes (uniq_contacts_ws_email / _linkedin / _salesnav) and ON CONFLICT targets exactly ONE. So we collect
   * every key across the chunk, run ≤3 workspace-scoped IN-list SELECTs (each per-workspace key is unique by its
   * partial index → at most one row per key), build lookup maps, then resolve each input by precedence in app.
   */
  async findByDedupKeysBatch(
    tx: Tx,
    workspaceId: string,
    keysList: DedupKeys[],
    opts: ContactReadOpts = {},
  ): Promise<Array<{ id: string } | null>> {
    if (keysList.length === 0) return [];

    const emailKeys: Uint8Array[] = [];
    const linkedinIds: string[] = [];
    const salesNavIds: string[] = [];
    for (const k of keysList) {
      if (k.emailBlindIndex) emailKeys.push(k.emailBlindIndex);
      if (k.linkedinPublicId) linkedinIds.push(k.linkedinPublicId);
      if (k.salesNavLeadId) salesNavIds.push(k.salesNavLeadId);
    }

    // S-CH4 (05 §6): gate-on the email rung's ONE IN-list SELECT retargets to contact_emails.blind_index
    // (secondaries resolve too), workspace-scoped; gate-off it reads contacts.email_blind_index, byte-identical.
    // Either way it stays one query per chunk and the §2.2 ws-unique keeps ≤1 hit per key ⇒ precedence exact.
    const emailMap = new Map<string, string>();
    if (emailKeys.length > 0) {
      if (opts.channelsFromChild) {
        const hits = await contactChannelRepository.findContactIdsByEmailBlindIndexes(
          tx,
          workspaceId,
          emailKeys,
        );
        for (const h of hits) emailMap.set(byteaKey(h.blindIndex), h.contactId);
      } else {
        const rows = await tx
          .select({ id: contacts.id, emailBlindIndex: contacts.emailBlindIndex })
          .from(contacts)
          .where(
            and(eq(contacts.workspaceId, workspaceId), inArray(contacts.emailBlindIndex, emailKeys)),
          );
        for (const r of rows) if (r.emailBlindIndex) emailMap.set(byteaKey(r.emailBlindIndex), r.id);
      }
    }

    const linkedinMap = new Map<string, string>();
    if (linkedinIds.length > 0) {
      const rows = await tx
        .select({ id: contacts.id, linkedinPublicId: contacts.linkedinPublicId })
        .from(contacts)
        .where(
          and(
            eq(contacts.workspaceId, workspaceId),
            inArray(contacts.linkedinPublicId, linkedinIds),
          ),
        );
      for (const r of rows) if (r.linkedinPublicId) linkedinMap.set(r.linkedinPublicId, r.id);
    }

    const salesNavMap = new Map<string, string>();
    if (salesNavIds.length > 0) {
      const rows = await tx
        .select({ id: contacts.id, salesNavLeadId: contacts.salesNavLeadId })
        .from(contacts)
        .where(
          and(eq(contacts.workspaceId, workspaceId), inArray(contacts.salesNavLeadId, salesNavIds)),
        );
      for (const r of rows) if (r.salesNavLeadId) salesNavMap.set(r.salesNavLeadId, r.id);
    }

    // Resolve each input by the findByDedupKeys precedence: email first (if a row hit), else linkedin, else
    // sales-nav, else null. A present-but-unmatched key falls through to the next, exactly like the single-row.
    return keysList.map((k) => {
      if (k.emailBlindIndex) {
        const id = emailMap.get(byteaKey(k.emailBlindIndex));
        if (id) return { id };
      }
      if (k.linkedinPublicId) {
        const id = linkedinMap.get(k.linkedinPublicId);
        if (id) return { id };
      }
      if (k.salesNavLeadId) {
        const id = salesNavMap.get(k.salesNavLeadId);
        if (id) return { id };
      }
      return null;
    });
  },

  /** Insert a new contact; returns its id. (undefined optional fields fall back to column defaults/null.) */
  async insert(tx: Tx, values: ContactWriteValues): Promise<string> {
    const rows = await tx.insert(contacts).values(values).returning({ id: contacts.id });
    return rows[0]!.id;
  },

  /**
   * Batched mirror of insert: ONE multi-row INSERT for a whole chunk, returning the new ids in input order.
   * Column handling matches insert (the value objects pass straight through — undefined optional fields fall
   * back to column defaults/null; no definedOnly, exactly like the single-row insert). A single INSERT statement's
   * RETURNING preserves the VALUES order, so result[i] is the id for values[i] (the caller relies on alignment).
   */
  async insertBatch(tx: Tx, values: ContactWriteValues[]): Promise<Array<{ id: string }>> {
    if (values.length === 0) return [];
    return tx.insert(contacts).values(values).returning({ id: contacts.id });
  },

  /** Merge non-undefined fields into an existing contact (sparse re-imports never wipe known values). */
  async update(tx: Tx, id: string, values: Partial<ContactWriteValues>): Promise<void> {
    await tx
      .update(contacts)
      .set({ ...definedOnly(values), updatedAt: new Date() })
      .where(eq(contacts.id, id));
  },

  /**
   * Batched updates for an import chunk. This LOOPS the single-row update rather than one set-based statement on
   * purpose: each row writes a DIFFERENT subset of columns (after planFieldWrite drops the rows' pinned scalars),
   * and definedOnly (never clobber a value with undefined) is inherently per-row — a single CASE/VALUES-join
   * UPDATE could not express the heterogeneous column sets safely. The batching win the design wants is the ONE
   * withTenantTx per chunk (not one tx per row), which the caller already owns; each iteration is byte-identical
   * to update (definedOnly + updatedAt bump), so semantics are preserved exactly.
   */
  async updateBatch(
    tx: Tx,
    updates: Array<{ id: string; values: Partial<ContactWriteValues> }>,
  ): Promise<void> {
    for (const u of updates) {
      await tx
        .update(contacts)
        .set({ ...definedOnly(u.values), updatedAt: new Date() })
        .where(eq(contacts.id, u.id));
    }
  },

  /** The non-PII inputs the rule-based scorer reads (ADR-0008). Tx-aware: composed in the score tx. */
  async getScoringInputs(
    tx: Tx,
    contactId: string,
  ): Promise<{
    seniorityLevel: string | null;
    jobTitle: string | null;
    emailDomain: string | null;
    hasEmail: boolean;
  } | null> {
    const rows = await tx
      .select({
        seniorityLevel: contacts.seniorityLevel,
        jobTitle: contacts.jobTitle,
        emailDomain: contacts.emailDomain,
        emailEnc: contacts.emailEnc,
      })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1);
    const r = rows[0];
    return r
      ? {
          seniorityLevel: r.seniorityLevel,
          jobTitle: r.jobTitle,
          emailDomain: r.emailDomain,
          hasEmail: r.emailEnc != null,
        }
      : null;
  },

  /**
   * The per-field provenance descriptor map for a contact (PLAN_03 §3.1) — the pin/source state the
   * enrichment + user-edit write paths read before deciding what may be overwritten. RLS-scoped via the
   * caller's tx (isolation rides the GUC, like getScoringInputs — no explicit workspace predicate). A
   * foreign/absent id (no visible row) → `{}`, as does a row whose `field_provenance` is null.
   */
  async getFieldProvenance(tx: Tx, contactId: string): Promise<FieldProvenanceMap> {
    const rows = await tx
      .select({ fieldProvenance: contacts.fieldProvenance })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1);
    return (rows[0]?.fieldProvenance as FieldProvenanceMap | null | undefined) ?? {};
  },

  /**
   * The contact's current SCALAR overlay values (the CONTACT_PROVENANCE_FIELDS subset), for cross-source conflict
   * detection at import-merge time (data-management #8). RLS-scoped via the caller's tx like getFieldProvenance;
   * a foreign/absent id → {}. Non-PII scalar profile fields ONLY (never email/phone). Used on the SYNC import
   * overwrite path (small files) — the dark high-volume bulk path does not compute conflicts per row.
   */
  async getScalarValues(tx: Tx, contactId: string): Promise<Record<string, unknown>> {
    const rows = await tx
      .select({
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        jobTitle: contacts.jobTitle,
        seniorityLevel: contacts.seniorityLevel,
        department: contacts.department,
        locationCountry: contacts.locationCountry,
        locationCity: contacts.locationCity,
      })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1);
    return (rows[0] as Record<string, unknown> | undefined) ?? {};
  },

  /**
   * Batched mirror of getScalarValues: one IN-list SELECT of the scalar overlay values for a whole chunk's
   * matched contacts (the BULK-path conflict detection read, data-management #8 — mirrors
   * getFieldProvenanceBatch). RLS-scoped via the caller's tx; a foreign/absent id is simply ABSENT from the
   * map — callers resolve it with `?? {}`, reproducing the single-row "no visible row → {}" contract.
   */
  async getScalarValuesBatch(
    tx: Tx,
    contactIds: string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const out = new Map<string, Record<string, unknown>>();
    if (contactIds.length === 0) return out;
    const rows = await tx
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        jobTitle: contacts.jobTitle,
        seniorityLevel: contacts.seniorityLevel,
        department: contacts.department,
        locationCountry: contacts.locationCountry,
        locationCity: contacts.locationCity,
      })
      .from(contacts)
      .where(inArray(contacts.id, contactIds));
    for (const { id, ...scalars } of rows) out.set(id, scalars);
    return out;
  },

  /**
   * Batched mirror of getFieldProvenance: one IN-list SELECT for a whole chunk's matched contacts, RLS-scoped via
   * the caller's tx (isolation rides the GUC — no explicit workspace predicate, like getFieldProvenance). Returns
   * a map of contactId → provenance for the rows that exist+are visible; a null field_provenance maps to {} (the
   * single-row default). A foreign/absent id is simply ABSENT from the map — callers resolve it with `?? {}`, which
   * reproduces getFieldProvenance's "no visible row → {}" contract.
   */
  async getFieldProvenanceBatch(
    tx: Tx,
    contactIds: string[],
  ): Promise<Map<string, FieldProvenanceMap>> {
    const out = new Map<string, FieldProvenanceMap>();
    if (contactIds.length === 0) return out;
    const rows = await tx
      .select({ id: contacts.id, fieldProvenance: contacts.fieldProvenance })
      .from(contacts)
      .where(inArray(contacts.id, contactIds));
    for (const r of rows) {
      out.set(r.id, (r.fieldProvenance as FieldProvenanceMap | null | undefined) ?? {});
    }
    return out;
  },

  /** Masked, workspace-scoped list for the search/results + post-import surfaces. Never returns PII.
   *  `opts.channelsFromChild` (caller-evaluated S-CH4 gate) adds the masked `channels` summaries + derives
   *  has_email/has_phone from live child rows; default off ⇒ byte-identical to the pre-S-CH4 projection. */
  async listByWorkspace(
    scope: TenantScope,
    limit = 100,
    opts: ContactReadOpts = {},
  ): Promise<MaskedContact[]> {
    return withTenantTx(scope, async (tx) => {
      // DSAR tombstones never surface (08 §4.2).
      const rows = await tx
        .select()
        .from(contacts)
        .where(isNull(contacts.deletedAt))
        .orderBy(desc(contacts.createdAt))
        .limit(limit);
      return withChannelSummaries(tx, rows, opts);
    });
  },

  /**
   * Resolve a single masked contact by its LinkedIn public identifier (the `/in/<publicId>` slug the browser
   * extension extracts) — the resolver behind the extension's LOOKUP (chrome-extension/14 X01). RLS scopes this
   * to ONE workspace via the caller's withTenantTx GUC (isolation rides the tx, like listByWorkspace — it never
   * crosses workspaces or tenants); the partial `uniq_contacts_ws_linkedin` (workspace_id, linkedin_public_id)
   * guarantees at most one LIVE row per slug. Returns the SAME masked, non-PII projection as the list/search
   * surfaces (`toMaskedContact` via `withChannelSummaries`) — never the email/phone plaintext. Null when this
   * workspace holds no live contact for the slug. Soft-deleted rows never surface (unlike findByDedupKeys, this
   * is a user-facing "do we already have this prospect" read, not import dedup).
   */
  async resolveByLinkedinPublicId(
    scope: TenantScope,
    linkedinPublicId: string,
    opts: ContactReadOpts = {},
  ): Promise<MaskedContact | null> {
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .select()
        .from(contacts)
        .where(and(eq(contacts.linkedinPublicId, linkedinPublicId), isNull(contacts.deletedAt)))
        .limit(1);
      if (rows.length === 0) return null;
      const [masked] = await withChannelSummaries(tx, rows, opts);
      return masked ?? null;
    });
  },

  /**
   * Per-workspace data-quality rollup (10 §5 / 22 — the Data Health dashboard): a LIVE aggregate over the
   * workspace's non-tombstoned contacts → raw counts (fill / email+phone verification / freshness) the UI turns
   * into rates. One aggregate scan per call (Postgres-native, fine at lakh-row scale — a precomputed snapshot is
   * the deferred scale optimization). Freshness uses the record-level email-SLA proxy (reverifyCutoff, ADR-0025).
   * RLS scopes every count to the workspace; nothing returned is PII (counts + present-flags + statuses only).
   */
  async dataQualitySummary(scope: TenantScope): Promise<WorkspaceDataQuality> {
    const cutoff = reverifyCutoff();
    return withTenantTx(scope, async (tx) => {
      const [r] = (await tx.execute(sql`
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE first_name IS NOT NULL OR last_name IS NOT NULL)::int AS with_name,
          count(email_enc)::int AS with_email,
          count(phone_enc)::int AS with_phone,
          count(job_title)::int AS with_title,
          count(*) FILTER (WHERE account_id IS NOT NULL OR email_domain IS NOT NULL)::int AS with_company,
          count(*) FILTER (WHERE linkedin_public_id IS NOT NULL OR linkedin_url IS NOT NULL)::int AS with_linkedin,
          count(*) FILTER (WHERE location_country IS NOT NULL OR location_city IS NOT NULL)::int AS with_location,
          count(*) FILTER (WHERE email_status = 'valid')::int AS email_valid,
          count(*) FILTER (WHERE email_status = 'risky')::int AS email_risky,
          count(*) FILTER (WHERE email_status = 'invalid')::int AS email_invalid,
          count(*) FILTER (WHERE email_status = 'catch_all')::int AS email_catch_all,
          count(*) FILTER (WHERE email_status = 'unverified')::int AS email_unverified,
          count(*) FILTER (WHERE email_status = 'unknown')::int AS email_unknown,
          count(*) FILTER (WHERE phone_status IN ('direct','mobile','hq','valid'))::int AS phone_valid,
          count(*) FILTER (WHERE phone_status = 'invalid')::int AS phone_invalid,
          count(*) FILTER (WHERE phone_line_type = 'mobile')::int AS phone_mobile,
          count(*) FILTER (WHERE phone_line_type = 'landline')::int AS phone_landline,
          count(*) FILTER (WHERE phone_line_type = 'voip')::int AS phone_voip,
          count(*) FILTER (WHERE last_verified_at >= ${cutoff})::int AS fresh,
          count(*) FILTER (WHERE last_verified_at < ${cutoff})::int AS stale,
          count(*) FILTER (WHERE last_verified_at IS NULL)::int AS never_verified
        FROM contacts
        WHERE deleted_at IS NULL
      `)) as unknown as Array<Record<string, number>>;
      return {
        total: r?.total ?? 0,
        withName: r?.with_name ?? 0,
        withEmail: r?.with_email ?? 0,
        withPhone: r?.with_phone ?? 0,
        withTitle: r?.with_title ?? 0,
        withCompany: r?.with_company ?? 0,
        withLinkedin: r?.with_linkedin ?? 0,
        withLocation: r?.with_location ?? 0,
        emailValid: r?.email_valid ?? 0,
        emailRisky: r?.email_risky ?? 0,
        emailInvalid: r?.email_invalid ?? 0,
        emailCatchAll: r?.email_catch_all ?? 0,
        emailUnverified: r?.email_unverified ?? 0,
        emailUnknown: r?.email_unknown ?? 0,
        phoneValid: r?.phone_valid ?? 0,
        phoneInvalid: r?.phone_invalid ?? 0,
        phoneMobile: r?.phone_mobile ?? 0,
        phoneLandline: r?.phone_landline ?? 0,
        phoneVoip: r?.phone_voip ?? 0,
        fresh: r?.fresh ?? 0,
        stale: r?.stale ?? 0,
        neverVerified: r?.never_verified ?? 0,
      };
    });
  },

  /**
   * Multi-source COVERAGE count (data-management #8): LIVE contacts whose `field_provenance` attributes fields to
   * ≥2 DISTINCT data sources — `user_edit` excluded (a human correction is provenance, not a data source). A
   * COVERAGE proxy (how many records are corroborated by multiple sources), NOT a true value-conflict rate (that
   * would need disagreement recorded at merge time — field_provenance keeps only the winner). The per-row
   * `jsonb_each` scan is DELIBERATELY off the live dashboard read (dataQualitySummary): this runs ONLY in the daily
   * snapshot sweep. Workspace-scoped via RLS (own withTenantTx), LIVE contacts only (deleted_at IS NULL).
   */
  async multiSourceContactCount(scope: TenantScope): Promise<number> {
    return withTenantTx(scope, async (tx) => {
      const [r] = (await tx.execute(sql`
        SELECT count(*)::int AS multi_source
        FROM contacts
        WHERE deleted_at IS NULL
          AND (
            SELECT count(DISTINCT (v ->> 'src'))
            FROM jsonb_each(contacts.field_provenance) AS e(k, v)
            WHERE (v ->> 'src') <> 'user_edit'
          ) >= 2
      `)) as unknown as Array<Record<string, number>>;
      return r?.multi_source ?? 0;
    });
  },

  /**
   * TRUE cross-source conflict count (data-management #8): LIVE contacts whose `field_provenance` carries at least
   * one field flagged `cf:true` — a field overwritten by a DIFFERENT source with a DIFFERENT normalized value
   * (set at import-merge time by markConflicts). Unlike multiSourceContactCount (mere corroboration breadth), this
   * is real DISAGREEMENT. Same periodic-only posture: the per-row jsonb scan runs ONLY in the daily snapshot, never
   * the live read. Workspace-scoped via RLS (own withTenantTx), LIVE contacts only (deleted_at IS NULL).
   */
  async conflictContactCount(scope: TenantScope): Promise<number> {
    return withTenantTx(scope, async (tx) => {
      const [r] = (await tx.execute(sql`
        SELECT count(*)::int AS conflicts
        FROM contacts
        WHERE deleted_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM jsonb_each(contacts.field_provenance) AS e(k, v)
            WHERE (v ->> 'cf') = 'true'
          )
      `)) as unknown as Array<Record<string, number>>;
      return r?.conflicts ?? 0;
    });
  },

  /**
   * The subset of `ids` that are LIVE (non-tombstoned) contacts visible in the caller's workspace (RLS). This
   * is the cross-workspace guard every bulk mutation runs first — only these ids may be touched, mirroring
   * listRepository.visibleContactIds. tx-aware so a bulk op composes it inside ONE withTenantTx as the mutation.
   */
  async visibleContactIds(tx: Tx, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(inArray(contacts.id, ids), isNull(contacts.deletedAt)));
    return rows.map((r) => r.id);
  },

  /**
   * Non-PII spend-estimate signals for a set of visible ids (list-plan/06 §4.2 estimate-before-run). Returns,
   * per live contact, the field-presence flags + reveal/verification state the credit projection reads — never
   * the encrypted email/phone, only their `IS NOT NULL` presence. Used by the bulk reveal/enrich ESTIMATE
   * (the cost shown before confirm), so the projection runs server-side over the real, RLS-scoped selection.
   * Callers MUST pass only WORKSPACE-VISIBLE ids (resolve via visibleContactIds / resolveVisibleSelection in
   * the SAME withTenantTx) — like assignOwner, isolation rides the RLS GUC on that tx, not an explicit
   * workspace predicate here, so a raw client-id list on a wrong-scope tx would leak cross-workspace signals.
   */
  async enrichSignalsByIds(tx: Tx, ids: string[]): Promise<EnrichEstimateSignal[]> {
    if (ids.length === 0) return [];
    const rows = await tx
      .select({
        id: contacts.id,
        hasEmail: sql<boolean>`${contacts.emailEnc} IS NOT NULL`,
        hasPhone: sql<boolean>`${contacts.phoneEnc} IS NOT NULL`,
        isRevealed: contacts.isRevealed,
        emailStatus: contacts.emailStatus,
      })
      .from(contacts)
      .where(and(inArray(contacts.id, ids), isNull(contacts.deletedAt)));
    return rows.map((r) => ({
      id: r.id,
      hasEmail: r.hasEmail,
      hasPhone: r.hasPhone,
      isRevealed: r.isRevealed,
      emailStatus: r.emailStatus,
    }));
  },

  /**
   * Bulk assign/reassign the SOFT owner (owner_user_id) for the given ids. `ownerUserId: null` clears it
   * (unassign). Callers MUST pass only workspace-visible ids (filter via visibleContactIds first); RLS is the
   * backstop. Returns how many rows were updated (the affected count). The owner-policy decision (admins set
   * any owner; members only self/clear) lives in core — this layer just writes. Tombstoned rows are excluded.
   */
  async assignOwner(tx: Tx, ids: string[], ownerUserId: string | null): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await tx
      .update(contacts)
      .set({ ownerUserId, updatedAt: new Date() })
      .where(and(inArray(contacts.id, ids), isNull(contacts.deletedAt)))
      .returning({ id: contacts.id });
    return rows.length;
  },

  /**
   * Bulk set outreach_status for the given ids. The value is validated against the closed enum at the API edge
   * (the DB CHECK is the backstop). Callers MUST pass only workspace-visible ids. Returns the affected count.
   */
  async setOutreachStatus(tx: Tx, ids: string[], outreachStatus: string): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await tx
      .update(contacts)
      .set({ outreachStatus, updatedAt: new Date() })
      .where(and(inArray(contacts.id, ids), isNull(contacts.deletedAt)))
      .returning({ id: contacts.id });
    return rows.length;
  },

  /**
   * Bulk SOFT-archive (hide) the given ids: stamp deleted_at so the rows stop surfacing in search/lists. This
   * is the reversible archive/hide path — DISTINCT from the DSAR tombstone (08 §4.2), which additionally NULLs
   * PII and fans out the erasure. Only already-live rows are affected (the `deleted_at IS NULL` guard makes a
   * re-archive a no-op). Callers MUST pass only workspace-visible ids. Returns the affected count.
   */
  async archive(tx: Tx, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await tx
      .update(contacts)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(inArray(contacts.id, ids), isNull(contacts.deletedAt)))
      .returning({ id: contacts.id });
    return rows.length;
  },

  /**
   * Every live contact's dedup-relevant, NON-PII fields for the workspace (RLS-scoped via the caller's tx) —
   * the input to the dedup pass. Tombstoned rows are excluded. `hasPhone` is derived from the encrypted column
   * (the plaintext is never read). Bounded by the workspace size; the dedup worker runs off the request thread.
   */
  async listForDedup(tx: Tx): Promise<DedupContactRow[]> {
    const rows = await tx
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        emailDomain: contacts.emailDomain,
        jobTitle: contacts.jobTitle,
        linkedinUrl: contacts.linkedinUrl,
        seniorityLevel: contacts.seniorityLevel,
        department: contacts.department,
        locationCountry: contacts.locationCountry,
        phoneEnc: contacts.phoneEnc,
        isRevealed: contacts.isRevealed,
        createdAt: contacts.createdAt,
      })
      .from(contacts)
      .where(isNull(contacts.deletedAt));
    return rows.map((r) => ({
      id: r.id,
      firstName: r.firstName,
      lastName: r.lastName,
      emailDomain: r.emailDomain,
      jobTitle: r.jobTitle,
      linkedinUrl: r.linkedinUrl,
      seniorityLevel: r.seniorityLevel,
      department: r.department,
      locationCountry: r.locationCountry,
      hasPhone: r.phoneEnc != null,
      isRevealed: r.isRevealed,
      createdAt: r.createdAt,
    }));
  },

  /**
   * Clear every duplicate pointer in the workspace (partial — only rows currently flagged). The dedup pass
   * recomputes from scratch each run, so it clears first, then re-points the live groups (flagDuplicates). RLS
   * scopes this to the caller's workspace. duplicate_of_contact_id is a derived/system annotation, so updatedAt
   * is intentionally NOT bumped. Returns how many flags were cleared.
   */
  async clearDuplicateFlags(tx: Tx): Promise<number> {
    const rows = await tx
      .update(contacts)
      .set({ duplicateOfContactId: null })
      .where(isNotNull(contacts.duplicateOfContactId))
      .returning({ id: contacts.id });
    return rows.length;
  },

  /**
   * Point a set of duplicate contacts at their canonical contact (duplicate_of_contact_id = canonicalId).
   * canonicalId + duplicateIds are all same-workspace by construction (the dedup pass groups within one
   * RLS-scoped read); RLS is the backstop. Self-reference is impossible (canonical is excluded from its own
   * duplicateIds). Returns the number of rows flagged.
   */
  async flagDuplicates(tx: Tx, canonicalId: string, duplicateIds: string[]): Promise<number> {
    if (duplicateIds.length === 0) return 0;
    const rows = await tx
      .update(contacts)
      .set({ duplicateOfContactId: canonicalId })
      .where(inArray(contacts.id, duplicateIds))
      .returning({ id: contacts.id });
    return rows.length;
  },

  /**
   * S-C6 (import-and-data-model-redesign 04 §2 act layer): write ONE match-time duplicate SUGGESTION —
   * point `contactId` at `canonicalId` via duplicate_of_contact_id — feeding the review queue (G21, doc 11).
   * The MATCH-vs-ACT split (03 §2.1 [34]): a match-time signal (a secondary-value / phone-line collision the
   * primary-key ladder can't express as a conflict) NEVER updates, merges, or blocks the row — it lands per
   * policy and this pointer is the only side effect. GUARDED to stay a pure SUGGESTION: it writes ONLY when
   * the contact has NO existing pointer (never clobbers the dedup sweep's marker or a stronger signal) and
   * never self-references (the `contactId === canonicalId` short-circuit + the predicate). Like flagDuplicates
   * this is a derived annotation → updatedAt is intentionally NOT bumped. The marker is reversible/transient
   * (the dedup sweep re-derives markers wholesale on its next run — 04 §3.5); the DURABLE signal home is I5
   * `match_links`, out of scope here. RLS scopes the write to the caller's workspace. Returns whether a
   * pointer was written.
   */
  async markDuplicateSuggestion(tx: Tx, contactId: string, canonicalId: string): Promise<boolean> {
    if (contactId === canonicalId) return false;
    const rows = await tx
      .update(contacts)
      .set({ duplicateOfContactId: canonicalId })
      .where(and(eq(contacts.id, contactId), isNull(contacts.duplicateOfContactId)))
      .returning({ id: contacts.id });
    return rows.length > 0;
  },

  /**
   * List the workspace's DUPLICATE contacts (duplicate_of_contact_id set) paired with the canonical each was
   * auto-pointed at — the within-workspace dedup REVIEW read (database-management-research G09). RLS scopes BOTH
   * sides to the caller's workspace (the alias is the same RLS-scoped `contacts` table, so no cross-workspace
   * leak). NAMES ONLY — never the encrypted email/phone (the review identifies the pair; reveal is separate).
   * Newest duplicate first, bounded.
   */
  async listDuplicatePairs(tx: Tx, limit = 200): Promise<DuplicatePairRow[]> {
    const canonical = alias(contacts, "dedup_canonical");
    return tx
      .select({
        duplicateId: contacts.id,
        duplicateFirstName: contacts.firstName,
        duplicateLastName: contacts.lastName,
        duplicateCreatedAt: contacts.createdAt,
        canonicalId: canonical.id,
        canonicalFirstName: canonical.firstName,
        canonicalLastName: canonical.lastName,
      })
      .from(contacts)
      .innerJoin(canonical, eq(contacts.duplicateOfContactId, canonical.id))
      .where(isNotNull(contacts.duplicateOfContactId))
      .orderBy(desc(contacts.createdAt))
      .limit(Math.max(1, Math.min(500, Math.trunc(limit))));
  },

  /**
   * OVERRIDE one auto-dedup decision: clear a single contact's duplicate pointer so it surfaces as its own record
   * again (the customer's "this is NOT a duplicate" action). RLS-scoped to the workspace; only clears a row that is
   * currently flagged. duplicate_of_contact_id is a derived annotation, so updatedAt is intentionally not bumped
   * (matches clearDuplicateFlags). Returns true iff a flag was cleared.
   */
  async unmarkDuplicate(tx: Tx, contactId: string): Promise<boolean> {
    const rows = await tx
      .update(contacts)
      .set({ duplicateOfContactId: null })
      .where(and(eq(contacts.id, contactId), isNotNull(contacts.duplicateOfContactId)))
      .returning({ id: contacts.id });
    return rows.length > 0;
  },

  /**
   * The MASKED, non-PII columns for an explicit id set, in a single workspace-scoped tx — the source rows for
   * the role-gated CSV export. Never selects the encrypted email/phone (export ships facets only, never PII).
   * Tombstoned rows are excluded. Order is stable (created_at desc, id desc) so the CSV is deterministic.
   */
  async listMaskedByIds(
    tx: Tx,
    ids: string[],
    opts: ContactReadOpts = {},
  ): Promise<MaskedContact[]> {
    if (ids.length === 0) return [];
    const rows = await tx
      .select()
      .from(contacts)
      .where(and(inArray(contacts.id, ids), isNull(contacts.deletedAt)))
      .orderBy(desc(contacts.createdAt), desc(contacts.id));
    return withChannelSummaries(tx, rows, opts);
  },

  /**
   * The highest-priority leads for the Home dashboard (top N by priority_score). FACETS ONLY — the
   * encrypted email/phone are never selected. DSAR tombstones never surface (08 §4.2). Workspace-scoped.
   * Pass `tx` to run on a caller's existing scoped transaction (e.g. the Home summary fan-out); omit it
   * for a standalone read.
   */
  async topByPriority(scope: TenantScope, limit = 5, tx?: Tx): Promise<HotLeadRow[]> {
    const run = async (t: Tx): Promise<HotLeadRow[]> => {
      const rows = await t
        .select({
          id: contacts.id,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          jobTitle: contacts.jobTitle,
          emailDomain: contacts.emailDomain,
          priorityScore: contacts.priorityScore,
          outreachStatus: contacts.outreachStatus,
          isRevealed: contacts.isRevealed,
        })
        .from(contacts)
        .where(and(isNull(contacts.deletedAt), isNotNull(contacts.priorityScore)))
        .orderBy(desc(contacts.priorityScore))
        .limit(limit);
      return rows.map((r) => ({ ...r, priorityScore: r.priorityScore ?? 0 }));
    };
    return tx ? run(tx) : withTenantTx(scope, run);
  },
};
