// sourceImportRepository.ts — data access for `source_imports` (import domain): the per-import provenance
// row written for every imported contact — the ONLY lineage under the per-workspace model (ADR-0006).
// Tx-aware so it composes into the import pipeline's per-row transaction (03 §9). `content_hash` lets an
// identical re-import short-circuit to a no-op (idempotency).

import { and, eq } from "drizzle-orm";
import type { SourceName } from "@leadwolf/types";
import type { Tx } from "../client.ts";
import { sourceImports } from "../schema/contacts.ts";

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
  async findByContentHash(tx: Tx, workspaceId: string, contentHash: Uint8Array): Promise<{ contactId: string } | null> {
    const rows = await tx
      .select({ contactId: sourceImports.contactId })
      .from(sourceImports)
      .where(and(eq(sourceImports.workspaceId, workspaceId), eq(sourceImports.contentHash, contentHash)))
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
};
