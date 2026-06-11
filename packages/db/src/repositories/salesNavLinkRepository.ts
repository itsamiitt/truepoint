// salesNavLinkRepository.ts — data access for captured Sales Navigator links (sales-navigator domain,
// 05 §5, M7). HITL capture only (ADR-0009); the (workspace_id, url) unique index makes re-pastes
// conflict instead of accumulating copies. String-typed like revealRepository: the closed link_type
// enum lives in @leadwolf/types and the CHECK constraint; the api narrows at the edge.

import { and, desc, eq } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { salesNavLinks } from "../schema/salesnav.ts";

export interface SalesNavLinkInsert {
  tenantId: string;
  workspaceId: string;
  linkType: string;
  url: string;
  externalId?: string | null;
  contactId?: string | null;
  accountId?: string | null;
  createdByUserId?: string | null;
}

export interface SalesNavLinkRecord {
  id: string;
  linkType: string;
  url: string;
  externalId: string | null;
  contactId: string | null;
  accountId: string | null;
  createdAt: Date;
}

export const salesNavLinkRepository = {
  async insert(tx: Tx, link: SalesNavLinkInsert): Promise<string> {
    const inserted = await tx
      .insert(salesNavLinks)
      .values(link)
      .returning({ id: salesNavLinks.id });
    return inserted[0]!.id;
  },

  /** Newest-first captured links for the workspace (05 §5). Workspace-scoped via RLS. */
  async listByWorkspace(scope: TenantScope, limit = 100): Promise<SalesNavLinkRecord[]> {
    return withTenantTx(scope, (tx) =>
      tx
        .select({
          id: salesNavLinks.id,
          linkType: salesNavLinks.linkType,
          url: salesNavLinks.url,
          externalId: salesNavLinks.externalId,
          contactId: salesNavLinks.contactId,
          accountId: salesNavLinks.accountId,
          createdAt: salesNavLinks.createdAt,
        })
        .from(salesNavLinks)
        .where(
          and(
            eq(salesNavLinks.workspaceId, scope.workspaceId ?? ""),
            eq(salesNavLinks.tenantId, scope.tenantId),
          ),
        )
        .orderBy(desc(salesNavLinks.createdAt))
        .limit(limit),
    );
  },
};
