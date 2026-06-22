// contactRepository.ts — data access for `contacts` (reveal/contacts domain). Holds the per-workspace dedup
// lookups + writes used by the import pipeline (tx-aware, composed inside one withTenantTx), plus the
// self-contained masked list the API/search surfaces read. PII (email/phone) is stored encrypted; this
// layer never returns plaintext — callers see only the non-PII facets until reveal (M3). 03 §5/§9.

import type { MaskedContact } from "@leadwolf/types";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { contacts } from "../schema/contacts.ts";

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
  linkedinUrl?: string | null;
  linkedinPublicId?: string | null;
  salesNavProfileUrl?: string | null;
  salesNavLeadId?: string | null;
  locationCountry?: string | null;
  locationCity?: string | null;
}

/** Drop undefined keys so an UPDATE never overwrites an existing value with `undefined`. */
function definedOnly<T extends object>(v: T): Partial<T> {
  return Object.fromEntries(Object.entries(v).filter(([, val]) => val !== undefined)) as Partial<T>;
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

export const contactRepository = {
  /** Find an existing contact in the workspace by the first dedup key that hits (email → linkedin → sales-nav). */
  async findByDedupKeys(
    tx: Tx,
    workspaceId: string,
    keys: DedupKeys,
  ): Promise<{ id: string } | null> {
    if (keys.emailBlindIndex) {
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

  /** Insert a new contact; returns its id. (undefined optional fields fall back to column defaults/null.) */
  async insert(tx: Tx, values: ContactWriteValues): Promise<string> {
    const rows = await tx.insert(contacts).values(values).returning({ id: contacts.id });
    return rows[0]!.id;
  },

  /** Merge non-undefined fields into an existing contact (sparse re-imports never wipe known values). */
  async update(tx: Tx, id: string, values: Partial<ContactWriteValues>): Promise<void> {
    await tx
      .update(contacts)
      .set({ ...definedOnly(values), updatedAt: new Date() })
      .where(eq(contacts.id, id));
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

  /** Masked, workspace-scoped list for the search/results + post-import surfaces. Never returns PII. */
  async listByWorkspace(scope: TenantScope, limit = 100): Promise<MaskedContact[]> {
    return withTenantTx(scope, async (tx) => {
      // DSAR tombstones never surface (08 §4.2).
      const rows = await tx
        .select()
        .from(contacts)
        .where(isNull(contacts.deletedAt))
        .orderBy(desc(contacts.createdAt))
        .limit(limit);
      return rows.map((r) => ({
        id: r.id,
        firstName: r.firstName,
        lastName: r.lastName,
        jobTitle: r.jobTitle,
        emailDomain: r.emailDomain,
        emailStatus: r.emailStatus as MaskedContact["emailStatus"],
        hasEmail: r.emailEnc != null,
        hasPhone: r.phoneEnc != null,
        seniorityLevel: r.seniorityLevel as MaskedContact["seniorityLevel"],
        department: r.department,
        locationCountry: r.locationCountry,
        locationCity: r.locationCity,
        outreachStatus: r.outreachStatus as MaskedContact["outreachStatus"],
        isRevealed: r.isRevealed,
        // Soft owner (the assignable "My prospects" dimension); falls back to the first-reveal owner for rows
        // not yet assigned/backfilled. Non-PII user FK.
        ownerUserId: r.ownerUserId ?? r.revealedByUserId,
        createdAt: r.createdAt.toISOString(), // T4b: date dimension (created_at is non-null).
      }));
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
   * The MASKED, non-PII columns for an explicit id set, in a single workspace-scoped tx — the source rows for
   * the role-gated CSV export. Never selects the encrypted email/phone (export ships facets only, never PII).
   * Tombstoned rows are excluded. Order is stable (created_at desc, id desc) so the CSV is deterministic.
   */
  async listMaskedByIds(tx: Tx, ids: string[]): Promise<MaskedContact[]> {
    if (ids.length === 0) return [];
    const rows = await tx
      .select()
      .from(contacts)
      .where(and(inArray(contacts.id, ids), isNull(contacts.deletedAt)))
      .orderBy(desc(contacts.createdAt), desc(contacts.id));
    return rows.map((r) => ({
      id: r.id,
      firstName: r.firstName,
      lastName: r.lastName,
      jobTitle: r.jobTitle,
      emailDomain: r.emailDomain,
      emailStatus: r.emailStatus as MaskedContact["emailStatus"],
      hasEmail: r.emailEnc != null,
      hasPhone: r.phoneEnc != null,
      seniorityLevel: r.seniorityLevel as MaskedContact["seniorityLevel"],
      department: r.department,
      locationCountry: r.locationCountry,
      locationCity: r.locationCity,
      outreachStatus: r.outreachStatus as MaskedContact["outreachStatus"],
      isRevealed: r.isRevealed,
      ownerUserId: r.ownerUserId ?? r.revealedByUserId,
      createdAt: r.createdAt.toISOString(),
    }));
  },

  /**
   * The highest-priority leads for the Home dashboard (top N by priority_score). FACETS ONLY — the
   * encrypted email/phone are never selected. DSAR tombstones never surface (08 §4.2). Workspace-scoped.
   */
  async topByPriority(scope: TenantScope, limit = 5): Promise<HotLeadRow[]> {
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
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
    });
  },
};
