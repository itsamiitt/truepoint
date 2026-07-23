// extractionCandidateRepository — the AI-extract stage (S2) output writer (P-01.2). A plain function the extract
// worker adapts to persist runExtraction's per-field candidates {path, value, confidence, band, grounded}, which
// were previously discarded. Idempotent on (raw_capture_id, path): a re-extraction converges to the latest values
// rather than duplicating. Numeric confidence is stored as a Drizzle numeric string; never a channel PII value
// (email/phone stay blind-index-only at silver).
import { sql } from "drizzle-orm";
import type { Tx } from "../../client.ts";
import { extractionCandidates } from "../../schema/forge.ts";

export interface ExtractionCandidateInsert {
  rawCaptureId: string;
  path: string;
  value: unknown;
  confidence: number;
  band: string;
  grounded: boolean;
  extractSchemaVersion?: string;
}

export async function insertExtractionCandidates(
  tx: Tx,
  rows: ExtractionCandidateInsert[],
): Promise<{ written: number }> {
  if (rows.length === 0) return { written: 0 };
  const now = new Date();
  const written = await tx
    .insert(extractionCandidates)
    .values(
      rows.map((r) => ({
        rawCaptureId: r.rawCaptureId,
        path: r.path,
        value: r.value ?? null,
        confidence: r.confidence.toFixed(3),
        band: r.band,
        grounded: r.grounded,
        extractSchemaVersion: r.extractSchemaVersion ?? null,
        updatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [extractionCandidates.rawCaptureId, extractionCandidates.path],
      set: {
        value: sql`excluded.value`,
        confidence: sql`excluded.confidence`,
        band: sql`excluded.band`,
        grounded: sql`excluded.grounded`,
        extractSchemaVersion: sql`excluded.extract_schema_version`,
        updatedAt: now,
      },
    })
    .returning({ id: extractionCandidates.id });

  return { written: written.length };
}
