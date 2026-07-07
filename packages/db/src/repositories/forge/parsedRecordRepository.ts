// parsedRecordRepository — the db-backed silver upsert (08 §Replay). A plain function the workers adapt to
// @forge/core's ParsedRecordStore port (no db→core cycle). Idempotent on (raw_capture_id, parser_version_id):
// a re-derivation converges to the same row rather than duplicating (08 §M-FORGE-B.1/B.4).
import type { Tx } from "../../client.ts";
import { parsedRecords } from "../../schema/forge.ts";

export interface ParsedRecordUpsert {
  rawCaptureId: string;
  parserVersionId: string;
  entityKind?: string;
  parseStatus: string;
  fields: unknown;
  fieldProvenance: unknown;
  parseErrors: unknown;
  blockKey?: string;
  emailBlindIndex?: string;
  phoneBlindIndex?: string;
}

export async function upsertParsedRecord(
  tx: Tx,
  row: ParsedRecordUpsert,
): Promise<{ written: boolean }> {
  const written = await tx
    .insert(parsedRecords)
    .values({
      rawCaptureId: row.rawCaptureId,
      parserVersionId: row.parserVersionId,
      entityKind: row.entityKind ?? "person",
      fields: row.fields,
      fieldProvenance: row.fieldProvenance,
      parseStatus: row.parseStatus,
      parseErrors: row.parseErrors,
      blockKey: row.blockKey ?? null,
      emailBlindIndex: row.emailBlindIndex ?? null,
      phoneBlindIndex: row.phoneBlindIndex ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [parsedRecords.rawCaptureId, parsedRecords.parserVersionId],
      set: {
        fields: row.fields,
        fieldProvenance: row.fieldProvenance,
        parseStatus: row.parseStatus,
        parseErrors: row.parseErrors,
        blockKey: row.blockKey ?? null,
        emailBlindIndex: row.emailBlindIndex ?? null,
        phoneBlindIndex: row.phoneBlindIndex ?? null,
        superseded: false,
        updatedAt: new Date(),
      },
    })
    .returning({ id: parsedRecords.id });

  return { written: written.length > 0 };
}
