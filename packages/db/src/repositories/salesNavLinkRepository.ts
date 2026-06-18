// salesNavLinkRepository.ts — data access for captured Sales Navigator links (sales-navigator domain,
// 05 §5, M7). HITL capture only (ADR-0009); the (workspace_id, url) unique index (and the partial
// (workspace_id, sales_nav_lead_id) one) make re-pastes conflict instead of accumulating copies.
// String-typed like revealRepository: the closed link_type enum lives in @leadwolf/types and the CHECK
// constraint; the api narrows at the edge. `labels` round-trips as a jsonb string in the column.

import { and, desc, eq } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { salesNavLinks } from "../schema/salesnav.ts";

export interface SalesNavLinkInsert {
  tenantId: string;
  workspaceId: string;
  linkType: string;
  url: string;
  externalId?: string | null;
  salesNavLeadId?: string | null;
  note?: string | null;
  labels?: string[] | null;
  contactId?: string | null;
  accountId?: string | null;
  createdByUserId?: string | null;
  capturedAt?: Date | null;
}

export interface SalesNavLinkRecord {
  id: string;
  linkType: string;
  url: string;
  externalId: string | null;
  salesNavLeadId: string | null;
  note: string | null;
  labels: string[];
  contactId: string | null;
  accountId: string | null;
  capturedAt: Date;
  createdAt: Date;
}

/** insertDedup result: the id (new OR pre-existing) plus whether an identical link already existed. */
export interface SalesNavInsertResult {
  id: string;
  deduped: boolean;
}

/** Serialize the label list to the jsonb-string column shape; null when empty so the column stays sparse. */
function encodeLabels(labels: string[] | null | undefined): string | null {
  return labels && labels.length > 0 ? JSON.stringify(labels) : null;
}

/** Parse the stored jsonb-string column back to a string[]; tolerates null/legacy/garbage by returning []. */
function decodeLabels(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function toValues(link: SalesNavLinkInsert) {
  return {
    tenantId: link.tenantId,
    workspaceId: link.workspaceId,
    linkType: link.linkType,
    url: link.url,
    externalId: link.externalId ?? null,
    salesNavLeadId: link.salesNavLeadId ?? null,
    note: link.note ?? null,
    labels: encodeLabels(link.labels),
    contactId: link.contactId ?? null,
    accountId: link.accountId ?? null,
    createdByUserId: link.createdByUserId ?? null,
    ...(link.capturedAt ? { capturedAt: link.capturedAt } : {}),
  };
}

const SELECT_COLUMNS = {
  id: salesNavLinks.id,
  linkType: salesNavLinks.linkType,
  url: salesNavLinks.url,
  externalId: salesNavLinks.externalId,
  salesNavLeadId: salesNavLinks.salesNavLeadId,
  note: salesNavLinks.note,
  labels: salesNavLinks.labels,
  contactId: salesNavLinks.contactId,
  accountId: salesNavLinks.accountId,
  capturedAt: salesNavLinks.capturedAt,
  createdAt: salesNavLinks.createdAt,
} as const;

type RawRow = {
  id: string;
  linkType: string;
  url: string;
  externalId: string | null;
  salesNavLeadId: string | null;
  note: string | null;
  labels: string | null;
  contactId: string | null;
  accountId: string | null;
  capturedAt: Date;
  createdAt: Date;
};

function toRecord(r: RawRow): SalesNavLinkRecord {
  return { ...r, labels: decodeLabels(r.labels) };
}

export const salesNavLinkRepository = {
  /** Raw insert (conflicts surface as a duplicate-key error). Kept for callers that want strict insert. */
  async insert(tx: Tx, link: SalesNavLinkInsert): Promise<string> {
    const inserted = await tx
      .insert(salesNavLinks)
      .values(toValues(link))
      .returning({ id: salesNavLinks.id });
    return inserted[0]!.id;
  },

  /** Find the row that would collide with `link` by either unique facet (url, then lead id). RLS-scoped. */
  async findExisting(tx: Tx, link: SalesNavLinkInsert): Promise<string | null> {
    const byUrl = await tx
      .select({ id: salesNavLinks.id })
      .from(salesNavLinks)
      .where(and(eq(salesNavLinks.workspaceId, link.workspaceId), eq(salesNavLinks.url, link.url)))
      .limit(1);
    if (byUrl[0]) return byUrl[0].id;

    if (link.salesNavLeadId) {
      const byLead = await tx
        .select({ id: salesNavLinks.id })
        .from(salesNavLinks)
        .where(
          and(
            eq(salesNavLinks.workspaceId, link.workspaceId),
            eq(salesNavLinks.salesNavLeadId, link.salesNavLeadId),
          ),
        )
        .limit(1);
      if (byLead[0]) return byLead[0].id;
    }
    return null;
  },

  /**
   * Dedup-aware insert (05 §5): a re-pasted (workspace_id, url) — or the same parsed (workspace_id,
   * sales_nav_lead_id) — collapses onto the existing row instead of raising or accumulating. Returns the
   * surviving id and `deduped:true` when nothing new was inserted, so the UI can say "already captured".
   * Must run inside a withTenantTx scope (RLS gates which rows the conflict + fallback lookups can see).
   *
   * ON CONFLICT DO NOTHING covers BOTH unique indexes (url and the partial lead-id one), and `findExisting`
   * queries exactly those two facets — so any swallowed conflict resolves to a real row. The conflicting
   * row is committed-and-visible by the time we look (the insert already waited on its lock), so the
   * "not found after a conflict" branch is unreachable in practice; we surface it as an explicit error
   * rather than a bare insert that would abort the surrounding transaction.
   */
  async insertDedup(tx: Tx, link: SalesNavLinkInsert): Promise<SalesNavInsertResult> {
    const inserted = await tx
      .insert(salesNavLinks)
      .values(toValues(link))
      .onConflictDoNothing()
      .returning({ id: salesNavLinks.id });
    if (inserted[0]) return { id: inserted[0].id, deduped: false };

    const existingId = await this.findExisting(tx, link);
    if (existingId) return { id: existingId, deduped: true };

    throw new Error(
      "sales_nav_links: insert conflicted but no matching row was found (unexpected concurrency state)",
    );
  },

  /** Newest-captured-first links for the workspace (05 §5). Workspace-scoped via RLS. */
  async listByWorkspace(scope: TenantScope, limit = 200): Promise<SalesNavLinkRecord[]> {
    const rows = await withTenantTx(scope, (tx) =>
      tx
        .select(SELECT_COLUMNS)
        .from(salesNavLinks)
        .where(
          and(
            eq(salesNavLinks.workspaceId, scope.workspaceId ?? ""),
            eq(salesNavLinks.tenantId, scope.tenantId),
          ),
        )
        .orderBy(desc(salesNavLinks.capturedAt), desc(salesNavLinks.createdAt))
        .limit(limit),
    );
    return rows.map(toRecord);
  },

  /**
   * Delete one captured link by id, workspace-scoped (05 §5). RLS already constrains visibility, but the
   * explicit workspace_id predicate is defense-in-depth and lets the caller distinguish "deleted" (true)
   * from "no such link here" (false) without a separate read. Returns whether a row was removed.
   */
  async deleteById(scope: TenantScope, id: string): Promise<boolean> {
    return withTenantTx(scope, async (tx) => {
      const deleted = await tx
        .delete(salesNavLinks)
        .where(
          and(
            eq(salesNavLinks.id, id),
            eq(salesNavLinks.workspaceId, scope.workspaceId ?? ""),
            eq(salesNavLinks.tenantId, scope.tenantId),
          ),
        )
        .returning({ id: salesNavLinks.id });
      return deleted.length > 0;
    });
  },
};
