// revealRepository.ts — data access for the reveal transaction (reveal domain, 07 §3). Tx-aware pieces the
// core service composes inside ONE withTenantTx: the contact row (with ciphertext, for in-tx decryption by
// core — never returned over HTTP unmasked elsewhere), the idempotent reveal claim, and the usage list.

import type { RevealDataSource, RevealType } from "@leadwolf/types";
import { and, desc, eq, gte, isNull, lt, lte } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { contactReveals } from "../schema/billing.ts";
import { contacts } from "../schema/contacts.ts";

/** What the reveal transaction needs to know about the contact (RLS already scopes it to the workspace). */
export interface ContactForReveal {
  id: string;
  emailEnc: Uint8Array | null;
  emailBlindIndex: Uint8Array | null;
  emailDomain: string | null;
  emailStatus: string;
  phoneEnc: Uint8Array | null;
  isRevealed: boolean;
}

/** What the STAFF cross-tenant export needs per contact (database-management-research export; audit A1, Phase 2):
 *  the ciphertext (decrypted IN the executor, never returned over HTTP), the suppression keys, and the masked
 *  non-PII fields. Read ONLY under withPlatformTx (owner) — no RLS GUCs on this path, so the scope is EXPLICIT. */
export interface ContactForExport {
  id: string;
  firstName: string | null;
  lastName: string | null;
  jobTitle: string | null;
  emailEnc: Uint8Array | null;
  phoneEnc: Uint8Array | null;
  emailBlindIndex: Uint8Array | null;
  emailDomain: string | null;
  emailStatus: string;
  seniorityLevel: string | null;
  department: string | null;
  locationCountry: string | null;
  locationCity: string | null;
  createdAt: Date;
}

export interface RevealClaimInput {
  tenantId: string;
  workspaceId: string;
  contactId: string;
  revealedByUserId: string;
  revealType: RevealType;
  dataSource: RevealDataSource;
  creditsConsumed: number;
  revealedFields: string[];
}

export interface RevealUsageRow {
  id: string;
  contactId: string;
  revealType: string;
  dataSource: string;
  creditsConsumed: number;
  revealedAt: Date;
  revealedByUserId: string;
}

/** Selected usage columns shared by the list + export reads (PII-free). */
const USAGE_COLS = {
  id: contactReveals.id,
  contactId: contactReveals.contactId,
  revealType: contactReveals.revealType,
  dataSource: contactReveals.dataSource,
  creditsConsumed: contactReveals.creditsConsumed,
  revealedAt: contactReveals.revealedAt,
  revealedByUserId: contactReveals.revealedByUserId,
};

/** Bound the CSV export so one download can't scan the whole reveal history. */
const USAGE_EXPORT_CAP = 5000;

/** Optional filters for the usage history (all PII-free). */
export interface UsageFilter {
  revealType?: RevealType;
  dataSource?: RevealDataSource;
  from?: Date;
  to?: Date;
}

export interface UsageListOptions extends UsageFilter {
  limit?: number;
  cursor?: string;
}

// Opaque keyset cursor over the time-ordered v7 `id` (uuid_generate_v7 sorts by creation time, so `id DESC` is
// newest-first and `id < cursor` is the next older page). base64url, never an offset (mirrors platformAdminReads).
function encodeUsageCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}
function decodeUsageCursor(cursor: string): string | null {
  try {
    return Buffer.from(cursor, "base64url").toString("utf8") || null;
  } catch {
    return null;
  }
}

function usageConditions(scope: TenantScope, filter: UsageFilter, cursorId: string | null) {
  const conds = [
    eq(contactReveals.workspaceId, scope.workspaceId ?? ""),
    eq(contactReveals.tenantId, scope.tenantId),
  ];
  if (filter.revealType) conds.push(eq(contactReveals.revealType, filter.revealType));
  if (filter.dataSource) conds.push(eq(contactReveals.dataSource, filter.dataSource));
  if (filter.from) conds.push(gte(contactReveals.revealedAt, filter.from));
  if (filter.to) conds.push(lte(contactReveals.revealedAt, filter.to));
  if (cursorId) conds.push(lt(contactReveals.id, cursorId));
  return conds;
}

export const revealRepository = {
  /** Load the contact inside the reveal tx. Returns null when it doesn't exist in the scoped workspace. */
  async getContactForReveal(tx: Tx, contactId: string): Promise<ContactForReveal | null> {
    const rows = await tx
      .select({
        id: contacts.id,
        emailEnc: contacts.emailEnc,
        emailBlindIndex: contacts.emailBlindIndex,
        emailDomain: contacts.emailDomain,
        emailStatus: contacts.emailStatus,
        phoneEnc: contacts.phoneEnc,
        isRevealed: contacts.isRevealed,
      })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), isNull(contacts.deletedAt))) // tombstones are gone (08 §4.2)
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * Read a TARGET workspace's live contacts for a STAFF cross-tenant export — ciphertext + suppression keys +
   * masked fields, bounded. MUST run under withPlatformTx (owner): there are no RLS GUCs on this path, so the
   * tenant + workspace predicate is EXPLICIT. The ciphertext is decrypted IN the executor (never returned over
   * HTTP); the executor's findMatchExplicit gate excludes suppressed subjects before any decrypt is surfaced.
   */
  async listForExport(
    tx: Tx,
    tenantId: string,
    workspaceId: string,
    limit: number,
  ): Promise<ContactForExport[]> {
    return tx
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        jobTitle: contacts.jobTitle,
        emailEnc: contacts.emailEnc,
        phoneEnc: contacts.phoneEnc,
        emailBlindIndex: contacts.emailBlindIndex,
        emailDomain: contacts.emailDomain,
        emailStatus: contacts.emailStatus,
        seniorityLevel: contacts.seniorityLevel,
        department: contacts.department,
        locationCountry: contacts.locationCountry,
        locationCity: contacts.locationCity,
        createdAt: contacts.createdAt,
      })
      .from(contacts)
      .where(
        and(
          eq(contacts.tenantId, tenantId),
          eq(contacts.workspaceId, workspaceId),
          isNull(contacts.deletedAt),
        ),
      )
      .orderBy(contacts.id)
      .limit(limit);
  },

  /**
   * Which contact fields this workspace already owns a reveal claim for (ANY reveal_type, ANY prior cost).
   * Drives the cross-reveal-type dedup in revealContact so a field is never charged twice: email ⇐ an
   * email|full_profile claim; phone ⇐ a phone|full_profile claim. RLS scopes contact_reveals to the workspace;
   * the explicit predicate is defence-in-depth (mirrors usageConditions). Read inside the reveal tx, BEFORE
   * the current claim insert, so it reflects only PRIOR ownership.
   */
  async ownedRevealFields(
    tx: Tx,
    workspaceId: string,
    contactId: string,
  ): Promise<{ email: boolean; phone: boolean }> {
    const rows = (await tx
      .select({ revealType: contactReveals.revealType })
      .from(contactReveals)
      .where(
        and(eq(contactReveals.workspaceId, workspaceId), eq(contactReveals.contactId, contactId)),
      )) as Array<{ revealType: string }>;
    let email = false;
    let phone = false;
    for (const r of rows) {
      if (r.revealType === "email" || r.revealType === "full_profile") email = true;
      if (r.revealType === "phone" || r.revealType === "full_profile") phone = true;
    }
    return { email, phone };
  },

  /**
   * The idempotent reveal claim: INSERT … ON CONFLICT (workspace_id, contact_id, reveal_type) DO NOTHING.
   * Returns the new claim's `{ id }` when THIS call claimed the reveal (→ charge), or null when the workspace
   * copy already owned it (→ free re-reveal). The id backs the M11 credit-ledger `spend` entry (reveal_id +
   * idempotency_key reveal:<id>). The AFTER INSERT trigger flips contact ownership, first-wins (03 §10).
   */
  async claimReveal(tx: Tx, input: RevealClaimInput): Promise<{ id: string } | null> {
    const rows = await tx
      .insert(contactReveals)
      .values({ ...input, revealedFields: input.revealedFields })
      .onConflictDoNothing()
      .returning({ id: contactReveals.id });
    return rows[0] ?? null;
  },

  /**
   * Usage history for Settings ▸ Billing & Credits (07 §9). Workspace-scoped via RLS. Pass `tx` to compose
   * this into a caller's existing scoped transaction (e.g. the Home summary fan-out); omit it for a standalone
   * read. (Flat, capped — the paginated/filtered surface is listUsagePage.)
   */
  async listByWorkspace(scope: TenantScope, limit = 100, tx?: Tx): Promise<RevealUsageRow[]> {
    const run = (t: Tx): Promise<RevealUsageRow[]> =>
      t
        .select(USAGE_COLS)
        .from(contactReveals)
        .where(and(...usageConditions(scope, {}, null)))
        .orderBy(desc(contactReveals.revealedAt))
        .limit(limit) as Promise<RevealUsageRow[]>;
    return tx ? run(tx) : withTenantTx(scope, run);
  },

  /**
   * A keyset page of usage history with optional filters (type/source/date), newest-first over the v7 id. Uses
   * the limit+1 probe to compute the next cursor; null cursor = last page. Workspace-scoped via RLS.
   */
  async listUsagePage(
    scope: TenantScope,
    opts: UsageListOptions,
    tx?: Tx,
  ): Promise<{ rows: RevealUsageRow[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const cursorId = opts.cursor ? decodeUsageCursor(opts.cursor) : null;
    const run = async (t: Tx): Promise<{ rows: RevealUsageRow[]; nextCursor: string | null }> => {
      const rows = (await t
        .select(USAGE_COLS)
        .from(contactReveals)
        .where(and(...usageConditions(scope, opts, cursorId)))
        .orderBy(desc(contactReveals.id))
        .limit(limit + 1)) as RevealUsageRow[];
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      return { rows: page, nextCursor: hasMore && last ? encodeUsageCursor(last.id) : null };
    };
    return tx ? run(tx) : withTenantTx(scope, run);
  },

  /**
   * The filtered usage set for a CSV export, bounded by USAGE_EXPORT_CAP. Newest-first; no cursor. The route
   * guards each field against CSV formula injection before writing.
   */
  async listUsageForExport(
    scope: TenantScope,
    opts: UsageFilter,
    tx?: Tx,
  ): Promise<RevealUsageRow[]> {
    const run = (t: Tx): Promise<RevealUsageRow[]> =>
      t
        .select(USAGE_COLS)
        .from(contactReveals)
        .where(and(...usageConditions(scope, opts, null)))
        .orderBy(desc(contactReveals.id))
        .limit(USAGE_EXPORT_CAP) as Promise<RevealUsageRow[]>;
    return tx ? run(tx) : withTenantTx(scope, run);
  },
};
