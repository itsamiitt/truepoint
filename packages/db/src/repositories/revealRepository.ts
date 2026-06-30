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
   * The idempotent reveal claim: INSERT … ON CONFLICT (workspace_id, contact_id, reveal_type) DO NOTHING.
   * Returns true when THIS call claimed the reveal (→ charge), false when the workspace copy already owned
   * it (→ free re-reveal). The AFTER INSERT trigger flips contact ownership, first-wins (03 §10).
   */
  async claimReveal(tx: Tx, input: RevealClaimInput): Promise<boolean> {
    const rows = await tx
      .insert(contactReveals)
      .values({ ...input, revealedFields: input.revealedFields })
      .onConflictDoNothing()
      .returning({ id: contactReveals.id });
    return rows.length > 0;
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
