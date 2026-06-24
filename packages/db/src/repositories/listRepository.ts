// listRepository.ts — data access for static prospect lists (`lists` + `list_members`, 24 bulk add-to-list).
// The ONLY data layer for lists: every method is tx-aware (composed inside one withTenantTx by the core
// layer) so RLS scopes the rows to the active workspace. Two guarantees live here:
//   • visibility — lists are workspace-shared (every member sees them); mutations gate on owner in core.
//   • cross-workspace safety — addMembers only ever links contacts the caller can actually see (RLS),
//     so a member can never point at another workspace's contact even though FK checks bypass RLS.

import { type MaskedContact, ageDaysSince, computeContactDataQuality } from "@leadwolf/types";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { contacts } from "../schema/contacts.ts";
import { listMembers, lists } from "../schema/lists.ts";

/** A list row with its live membership count — the list/governance view-model. */
export interface ListRow {
  id: string;
  name: string;
  description: string | null;
  ownerUserId: string;
  memberCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** The values a create needs (workspace + owner come from the verified caller context). */
export interface ListInsert {
  tenantId: string;
  workspaceId: string;
  ownerUserId: string;
  name: string;
  description?: string | null;
}

export interface AddMembersInput {
  tenantId: string;
  workspaceId: string;
  listId: string;
  addedByUserId: string | null;
  contactIds: string[];
  /**
   * Per-member provenance (list-plan/02, Phase 0 columns). Defaults keep existing callers (the Phase-1
   * search/manual add path) unchanged — they land `added_via='manual'` with no import link. The import path
   * (list-plan/03 §2.2) passes `'import'` + the originating `source_imports` id. The same value applies to
   * EVERY contact in this call — the import path adds one contact per call, so the link is always exact.
   */
  addedVia?: "search" | "import" | "manual" | "api";
  sourceImportId?: string | null;
}

function toRow(r: typeof lists.$inferSelect, memberCount: number): ListRow {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    ownerUserId: r.ownerUserId,
    memberCount,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** One keyset page of a list's MASKED members + the opaque cursor for the next page (null at the end). */
export interface ListMembersResultPage {
  members: MaskedContact[];
  nextCursor: string | null;
}

/** The masked (non-PII) contact columns the members read selects — NEVER the encrypted email/phone. Mirrors
 *  contactRepository's masked projection so the members table reuses the prospect grid verbatim. `addedAt` is
 *  the join's keyset sort key (when the contact entered the list), distinct from the contact's createdAt. */
const MASKED_MEMBER = {
  id: contacts.id,
  firstName: contacts.firstName,
  lastName: contacts.lastName,
  jobTitle: contacts.jobTitle,
  emailDomain: contacts.emailDomain,
  emailStatus: contacts.emailStatus,
  phoneStatus: contacts.phoneStatus,
  hasEmail: sql<boolean>`${contacts.emailEnc} IS NOT NULL`,
  hasPhone: sql<boolean>`${contacts.phoneEnc} IS NOT NULL`,
  seniorityLevel: contacts.seniorityLevel,
  department: contacts.department,
  locationCountry: contacts.locationCountry,
  locationCity: contacts.locationCity,
  outreachStatus: contacts.outreachStatus,
  isRevealed: contacts.isRevealed,
  ownerUserId: sql<string | null>`coalesce(${contacts.ownerUserId}, ${contacts.revealedByUserId})`,
  createdAt: contacts.createdAt,
  lastVerifiedAt: contacts.lastVerifiedAt,
  // Non-PII present-flags the Data Health composer needs beyond email/phone (list-plan/06 §3.3). Derived in
  // SQL (boolean presence, never the value) so the masked DTO carries no extra PII — title/company/location/
  // linkedin completeness drives the 0–100 score. `hasCompany` = an account link OR an email domain facet.
  hasLinkedin: sql<boolean>`${contacts.linkedinPublicId} IS NOT NULL OR ${contacts.linkedinUrl} IS NOT NULL`,
  hasCompany: sql<boolean>`${contacts.accountId} IS NOT NULL OR ${contacts.emailDomain} IS NOT NULL`,
  // The keyset sort key, rendered as Postgres' FULL-PRECISION text (microseconds preserved). The cursor carries
  // this verbatim and the seek casts it straight back to ::timestamptz — round-tripping through a JS Date would
  // truncate to milliseconds and silently drop members that share a millisecond (e.g. a bulk add stamps every
  // member with the SAME transaction now() to the microsecond, so the boundary collision is guaranteed there).
  addedAtText: sql<string>`${listMembers.addedAt}::text`,
  memberId: listMembers.id,
} as const;

function toMaskedMember(r: Record<string, unknown>): MaskedContact {
  const emailStatus = r.emailStatus as MaskedContact["emailStatus"];
  const phoneStatus = r.phoneStatus as MaskedContact["phoneStatus"];
  const hasEmail = r.hasEmail as boolean;
  const hasPhone = r.hasPhone as boolean;
  const lastVerifiedAt = (r.lastVerifiedAt as Date | null)?.toISOString() ?? null;
  // The list-detail Data Health column (list-plan/06 §3.3): the read-side, derived 0–100 score + freshness
  // band, computed by the canonical `computeContactDataQuality` (single source in @leadwolf/types — never
  // re-derived). All inputs are non-PII present-flags + statuses + the last-verified age, so this is safe here.
  const dataHealth = computeContactDataQuality({
    hasName: (r.firstName as string | null) !== null || (r.lastName as string | null) !== null,
    hasEmail,
    hasPhone,
    hasTitle: (r.jobTitle as string | null) !== null,
    hasCompany: r.hasCompany as boolean,
    hasLocation:
      (r.locationCountry as string | null) !== null || (r.locationCity as string | null) !== null,
    hasLinkedin: r.hasLinkedin as boolean,
    emailStatus,
    phoneStatus,
    ageDaysSinceVerified: ageDaysSince(lastVerifiedAt),
  });
  return {
    id: r.id as string,
    firstName: r.firstName as string | null,
    lastName: r.lastName as string | null,
    jobTitle: r.jobTitle as string | null,
    emailDomain: r.emailDomain as string | null,
    emailStatus,
    phoneStatus,
    hasEmail,
    hasPhone,
    seniorityLevel: r.seniorityLevel as MaskedContact["seniorityLevel"],
    department: r.department as string | null,
    locationCountry: r.locationCountry as string | null,
    locationCity: r.locationCity as string | null,
    outreachStatus: r.outreachStatus as MaskedContact["outreachStatus"],
    isRevealed: r.isRevealed as boolean,
    ownerUserId: r.ownerUserId as string | null,
    createdAt: (r.createdAt as Date).toISOString(),
    lastVerifiedAt,
    dataHealth,
  };
}

/** Cursor = base64url JSON of the last member row's keyset (added_at + membership id). Keyset, never offset —
 *  mirrors searchRepository's cursor so the format is consistent across the masked-grid surfaces. */
function encodeMemberCursor(payload: { addedAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}
function decodeMemberCursor(cursor: string): { addedAt: string; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { addedAt?: unknown }).addedAt === "string" &&
      typeof (parsed as { id?: unknown }).id === "string"
    ) {
      return parsed as { addedAt: string; id: string };
    }
    return null;
  } catch {
    return null;
  }
}

export const listRepository = {
  /** Insert a new (empty) list; returns the persisted row. RLS pins it to the active workspace. */
  async insert(tx: Tx, values: ListInsert): Promise<ListRow> {
    const rows = await tx.insert(lists).values(values).returning();
    return toRow(rows[0]!, 0);
  },

  /** All lists in the workspace, alphabetical, each with its live member count. Workspace-scoped via RLS. */
  async listByWorkspace(scope: TenantScope): Promise<ListRow[]> {
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .select({
          id: lists.id,
          name: lists.name,
          description: lists.description,
          ownerUserId: lists.ownerUserId,
          createdAt: lists.createdAt,
          updatedAt: lists.updatedAt,
          memberCount: sql<number>`count(${listMembers.id})::int`,
        })
        .from(lists)
        .leftJoin(listMembers, eq(listMembers.listId, lists.id))
        .groupBy(lists.id)
        .orderBy(asc(lists.name));
      return rows.map((r) => ({ ...r, memberCount: r.memberCount ?? 0 }));
    });
  },

  /** Find one list by id within the caller's workspace (RLS scopes it); null if absent. */
  async findById(tx: Tx, id: string): Promise<{ id: string; ownerUserId: string } | null> {
    const rows = await tx
      .select({ id: lists.id, ownerUserId: lists.ownerUserId })
      .from(lists)
      .where(eq(lists.id, id))
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * One MASKED, keyset-paged page of a list's members (the contact ⋈ list_members join), newest-added-first.
   * Workspace-isolated via RLS (the join only sees this workspace's list_members + contacts), so a foreign
   * list id resolves to an empty page even if it somehow reached here — but callers gate on findById first for
   * an honest 404. Tombstoned contacts (DSAR) are excluded. Never selects the encrypted email/phone: the page
   * carries only the non-PII facets (reveal is the only de-masking path). tx-aware so it composes inside the
   * caller's withTenantTx.
   */
  async listMembers(
    tx: Tx,
    listId: string,
    limit: number,
    cursor: string | null,
  ): Promise<ListMembersResultPage> {
    const seek = cursor ? decodeMemberCursor(cursor) : null;
    // Keyset: order strictly by (added_at, membership id) DESC so the cursor seeks past the last row seen. The
    // membership id (a uuid v7) is the tiebreaker for members added in the same instant.
    const where = seek
      ? and(
          eq(listMembers.listId, listId),
          isNull(contacts.deletedAt),
          sql`(${listMembers.addedAt}, ${listMembers.id}) < (${seek.addedAt}::timestamptz, ${seek.id}::uuid)`,
        )
      : and(eq(listMembers.listId, listId), isNull(contacts.deletedAt));
    const rows = await tx
      .select(MASKED_MEMBER)
      .from(listMembers)
      .innerJoin(contacts, eq(contacts.id, listMembers.contactId))
      .where(where)
      .orderBy(sql`${listMembers.addedAt} DESC, ${listMembers.id} DESC`)
      .limit(limit + 1);
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    // Carry the DB's full-precision timestamp text straight into the cursor — no JS Date round-trip (which would
    // truncate to milliseconds and drop members sharing that millisecond on the next page).
    const nextCursor =
      more && last ? encodeMemberCursor({ addedAt: last.addedAtText, id: last.memberId }) : null;
    return { members: page.map(toMaskedMember), nextCursor };
  },

  /** Apply a rename / description change to a list OWNED by `ownerUserId`. Null when no owned row matched
   *  (wrong id, other workspace via RLS, or not the owner). */
  async updateOwned(
    tx: Tx,
    id: string,
    ownerUserId: string,
    patch: { name?: string; description?: string | null },
  ): Promise<ListRow | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;
    const rows = await tx
      .update(lists)
      .set(set)
      .where(and(eq(lists.id, id), eq(lists.ownerUserId, ownerUserId)))
      .returning();
    if (!rows[0]) return null;
    const countRows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(listMembers)
      .where(eq(listMembers.listId, id));
    return toRow(rows[0], countRows[0]?.n ?? 0);
  },

  /** Delete a list OWNED by `ownerUserId` (members cascade via FK). True when a row was removed. */
  async deleteOwned(tx: Tx, id: string, ownerUserId: string): Promise<boolean> {
    const rows = await tx
      .delete(lists)
      .where(and(eq(lists.id, id), eq(lists.ownerUserId, ownerUserId)))
      .returning({ id: lists.id });
    return rows.length > 0;
  },

  /** The subset of `ids` that are live (non-deleted) contacts visible in the caller's workspace (RLS). This
   *  is the cross-workspace guard for membership writes — only these ids may ever be linked. */
  async visibleContactIds(tx: Tx, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(inArray(contacts.id, ids), isNull(contacts.deletedAt)));
    return rows.map((r) => r.id);
  },

  /** Add contacts to a list. Idempotent: an existing (list, contact) link is ignored. Returns how many rows
   *  were ACTUALLY inserted (the affected count the UI confirms). Callers must pass workspace-visible ids.
   *  `addedVia`/`sourceImportId` default to the manual-add provenance so existing callers are unaffected. */
  async addMembers(tx: Tx, input: AddMembersInput): Promise<number> {
    if (input.contactIds.length === 0) return 0;
    const addedVia = input.addedVia ?? "manual";
    const sourceImportId = input.sourceImportId ?? null;
    const rows = await tx
      .insert(listMembers)
      .values(
        input.contactIds.map((contactId) => ({
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          listId: input.listId,
          contactId,
          addedByUserId: input.addedByUserId,
          addedVia,
          sourceImportId,
        })),
      )
      .onConflictDoNothing({ target: [listMembers.listId, listMembers.contactId] })
      .returning({ id: listMembers.id });
    return rows.length;
  },

  /** Remove contacts from a list. Returns how many membership rows were removed. Workspace-scoped via RLS. */
  async removeMembers(tx: Tx, listId: string, contactIds: string[]): Promise<number> {
    if (contactIds.length === 0) return 0;
    const rows = await tx
      .delete(listMembers)
      .where(and(eq(listMembers.listId, listId), inArray(listMembers.contactId, contactIds)))
      .returning({ id: listMembers.id });
    return rows.length;
  },
};
