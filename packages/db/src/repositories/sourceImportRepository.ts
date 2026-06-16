// sourceImportRepository.ts — data access for `source_imports` (import domain): the per-import provenance
// row written for every imported contact — the ONLY lineage under the per-workspace model (ADR-0006).
// Tx-aware so it composes into the import pipeline's per-row transaction (03 §9). `content_hash` lets an
// identical re-import short-circuit to a no-op (idempotency).

import type { SourceName } from "@leadwolf/types";
import { and, eq, sql } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { sourceImports } from "../schema/contacts.ts";

/** One import batch for the Home dashboard — a (file, source, minute) group with its contact count. */
export interface ImportBatchRow {
  sourceName: string;
  sourceFile: string | null;
  contactCount: number;
  importedAt: Date;
}

export interface SourceImportInput {
  tenantId: string;
  workspaceId: string;
  contactId: string;
  importedByUserId?: string | null;
  sourceName: SourceName;
  sourceFile?: string | null;
  rawData: Record<string, unknown>;
  contentHash?: Uint8Array | null;
}

export const sourceImportRepository = {
  /** Has this exact payload already been imported into this workspace? Drives idempotent skip. */
  async findByContentHash(
    tx: Tx,
    workspaceId: string,
    contentHash: Uint8Array,
  ): Promise<{ contactId: string } | null> {
    const rows = await tx
      .select({ contactId: sourceImports.contactId })
      .from(sourceImports)
      .where(
        and(eq(sourceImports.workspaceId, workspaceId), eq(sourceImports.contentHash, contentHash)),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /** Append one provenance row for an imported contact. */
  async append(tx: Tx, input: SourceImportInput): Promise<void> {
    await tx.insert(sourceImports).values({
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      contactId: input.contactId,
      importedByUserId: input.importedByUserId ?? null,
      sourceName: input.sourceName,
      sourceFile: input.sourceFile ?? null,
      rawData: input.rawData,
      contentHash: input.contentHash ?? null,
    });
  },

  /**
   * The most recent import batches for the Home dashboard: provenance rows grouped by
   * (source_file, source_name, minute) with their contact count, newest first. Workspace-scoped via RLS.
   */
  async recentBatches(scope: TenantScope, limit = 5): Promise<ImportBatchRow[]> {
    return withTenantTx(scope, async (tx) => {
      const minute = sql`date_trunc('minute', ${sourceImports.importedAt})`;
      const rows = await tx
        .select({
          sourceName: sourceImports.sourceName,
          sourceFile: sourceImports.sourceFile,
          contactCount: sql<number>`count(*)::int`,
          importedAt: sql<Date>`max(${sourceImports.importedAt})`,
        })
        .from(sourceImports)
        .groupBy(sourceImports.sourceFile, sourceImports.sourceName, minute)
        .orderBy(sql`max(${sourceImports.importedAt}) desc`)
        .limit(limit);
      return rows.map((r) => ({
        sourceName: r.sourceName,
        sourceFile: r.sourceFile,
        contactCount: Number(r.contactCount),
        // max() is a raw sql aggregate, so it skips drizzle's timestamp decoder — coerce to a Date
        // (the value arrives as a pg timestamp string; the Home DTO calls .toISOString() on it).
        importedAt: new Date(r.importedAt),
      }));
    });
  },
};
