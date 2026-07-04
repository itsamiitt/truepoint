// sourceImportRepository.ts — data access for `source_imports` (import domain): the per-import provenance
// row written for every imported contact — the ONLY lineage under the per-workspace model (ADR-0006).
// Tx-aware so it composes into the import pipeline's per-row transaction (03 §9). `content_hash` lets an
// identical re-import short-circuit to a no-op (idempotency).

import type { JobViewer, SourceName } from "@leadwolf/types";
import { and, eq, sql } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { sourceImports } from "../schema/contacts.ts";
import { creatorVisibility } from "./jobVisibility.ts";

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

  /** Append one provenance row for an imported contact; returns its id so the import path can link the
   *  resulting `list_members` row to this exact provenance row (list-plan/03 §2.2, `source_import_id`). */
  async append(tx: Tx, input: SourceImportInput): Promise<string> {
    const rows = await tx
      .insert(sourceImports)
      .values({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        contactId: input.contactId,
        importedByUserId: input.importedByUserId ?? null,
        sourceName: input.sourceName,
        sourceFile: input.sourceFile ?? null,
        rawData: input.rawData,
        contentHash: input.contentHash ?? null,
      })
      .returning({ id: sourceImports.id });
    return rows[0]!.id;
  },

  /**
   * Append a whole import chunk's provenance rows in ONE multi-row INSERT (15-bulk-import-design §2), with
   * ON CONFLICT (workspace_id, content_hash) DO NOTHING — the same idempotent re-import skip findByContentHash
   * drives on the sync path (append/findByContentHash stay for that path). The conflict target carries the
   * partial-index predicate `content_hash IS NOT NULL` (matching uniq_source_imports_ws_content): rows with a
   * NULL content_hash are not part of the unique index, so they never conflict and are always inserted. No
   * RETURNING — the bulk path links list members by contact id, not the per-row source_import_id (the sync path's
   * concern); callers needing the id keep using append.
   */
  async appendBatch(tx: Tx, inputs: SourceImportInput[]): Promise<void> {
    if (inputs.length === 0) return;
    await tx
      .insert(sourceImports)
      .values(
        inputs.map((input) => ({
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          contactId: input.contactId,
          importedByUserId: input.importedByUserId ?? null,
          sourceName: input.sourceName,
          sourceFile: input.sourceFile ?? null,
          rawData: input.rawData,
          contentHash: input.contentHash ?? null,
        })),
      )
      .onConflictDoNothing({
        target: [sourceImports.workspaceId, sourceImports.contentHash],
        // onConflictDoNothing's config takes `where` for the conflict-target predicate (only
        // onConflictDoUpdate uses `targetWhere`); both emit the same `ON CONFLICT (…) WHERE …`.
        where: sql`${sourceImports.contentHash} IS NOT NULL`,
      });
  },

  /**
   * The most recent import batches VISIBLE TO THE VIEWER for the Home dashboard: provenance rows grouped by
   * (source_file, source_name, minute) with their contact count, newest first. Workspace-scoped via RLS AND
   * viewer-scoped via the creator predicate on `imported_by_user_id` (import-redesign 10 §5 row 9): members
   * see their own batches; elevated roles see the workspace view; dual gate off ⇒ workspace-wide,
   * byte-identical (T-V4). The viewer is REQUIRED (10 §4.2 rule 1 — the unpredicated signature is gone).
   * Pass `tx` to run on a caller's existing scoped transaction (e.g. the Home summary fan-out); omit it
   * for a standalone read.
   */
  async recentBatches(
    scope: TenantScope,
    viewer: JobViewer,
    limit = 5,
    tx?: Tx,
  ): Promise<ImportBatchRow[]> {
    const run = async (t: Tx): Promise<ImportBatchRow[]> => {
      const minute = sql`date_trunc('minute', ${sourceImports.importedAt})`;
      const rows = await t
        .select({
          sourceName: sourceImports.sourceName,
          sourceFile: sourceImports.sourceFile,
          contactCount: sql<number>`count(*)::int`,
          importedAt: sql<Date>`max(${sourceImports.importedAt})`,
        })
        .from(sourceImports)
        .where(creatorVisibility(viewer, sourceImports.importedByUserId))
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
    };
    return tx ? run(tx) : withTenantTx(scope, run);
  },
};
