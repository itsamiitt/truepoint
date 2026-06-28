// bulkStage.ts — the DRIVE-phase STAGE step of the bulk COPY-staging import (15-bulk-import-design §2, backlog
// #2, phase 5). Streams the uploaded file from the FileStore in CONSTANT MEMORY, validates + prepares each row
// with the SAME canonical primitives as the synchronous path (`validateRow` + `prepareContact`, REUSED verbatim
// — the bulk-vs-sync parity guarantee), COPY-loads the prepared rows into the per-job staging table, then runs
// within-file dedup in SQL. Rejected rows are recorded (returned for the artifact) but NEVER staged.
//
// Per-row identity & precedence MIRROR runImport exactly: a row with no identity key is rejected by validateRow
// (before prepareContact, which would also throw); the `identity_key` written to staging uses the SAME
// email → linkedin → sales-nav precedence as contactRepository.findByDedupKeys, so within-file dedup collapses
// exactly the rows the against-existing dedup would consider the same person.

import { type ImportJobRow, type StagingRow, importStagingRepository } from "@leadwolf/db";
import type { BulkImportScope, ColumnMapping, RejectedRow, SourceName } from "@leadwolf/types";
import type { FileStore } from "../storage/fileStore.ts";
import { contentHash } from "./contentHash.ts";
import { type PreparedContact, prepareContact } from "./prepareContact.ts";
import { streamParseCsv } from "./streamParse.ts";
import { rejectedRowsFor, validateRow } from "./validateRow.ts";

export interface BulkStageInput {
  scope: BulkImportScope;
  /** The loaded control row — supplies the source-file key, column mapping, and source name. */
  job: ImportJobRow;
  fileStore: FileStore;
}

export interface BulkStageResult {
  /** Every parsed DATA row (rejected + staged); = the source file's row count after the header. */
  total: number;
  /** Rows that passed validation + preparation and were COPY-loaded into staging (includes the in-file dups). */
  staged: number;
  /** Distinct INPUT rows rejected (no identity key / malformed) — never staged. */
  rejected: number;
  /** Rows marked `dedup_in_file` (a non-survivor of within-file dedup). */
  dedupedInFile: number;
  /** The rejected-rows artifact entries (one per offending field) — the drive phase writes them to the FileStore. */
  rejectedRows: RejectedRow[];
}

/** The findByDedupKeys precedence, frozen into a single text key for SQL within-file dedup: email (hex of the
 *  blind index) → `li:<linkedin>` → `sn:<salesNav>` → null (no identity — survives, but validateRow rejects these). */
function identityKeyOf(prepared: PreparedContact): string | null {
  const keys = prepared.dedupKeys;
  if (keys.emailBlindIndex) return Buffer.from(keys.emailBlindIndex).toString("hex");
  if (keys.linkedinPublicId) return `li:${keys.linkedinPublicId}`;
  if (keys.salesNavLeadId) return `sn:${keys.salesNavLeadId}`;
  return null;
}

/** Build the staging row from the prepared contact + the raw source row + the content hash. The encrypted PII
 *  (email/phone) and its blind index/domain are present only when the source carried them — the absence is
 *  preserved as null so the merge can restore "field omitted" vs "explicit null" exactly like runImport. */
function toStagingRow(
  sourceRowNum: number,
  workspaceId: string,
  prepared: PreparedContact,
  hash: Uint8Array,
  raw: Record<string, string>,
): StagingRow {
  const v = prepared.values;
  return {
    sourceRowNum,
    workspaceId,
    identityKey: identityKeyOf(prepared),
    emailEnc: v.emailEnc ?? null,
    phoneEnc: v.phoneEnc ?? null,
    emailBlindIndex: v.emailBlindIndex ?? null,
    contentHash: hash,
    emailDomain: v.emailDomain ?? null,
    linkedinPublicId: v.linkedinPublicId ?? null,
    salesNavLeadId: v.salesNavLeadId ?? null,
    firstName: v.firstName ?? null,
    lastName: v.lastName ?? null,
    jobTitle: v.jobTitle ?? null,
    seniorityLevel: v.seniorityLevel ?? null,
    department: v.department ?? null,
    linkedinUrl: v.linkedinUrl ?? null,
    salesNavProfileUrl: v.salesNavProfileUrl ?? null,
    locationCountry: v.locationCountry ?? null,
    locationCity: v.locationCity ?? null,
    accountName: prepared.accountName ?? null,
    accountDomain: prepared.accountDomain ?? null,
    rawData: raw,
  };
}

/**
 * Stage a bulk import: stream-parse → validate → prepare → COPY into staging → within-file dedup. Constant
 * memory — the file is never fully buffered; staged rows stream straight into COPY as they are produced. The
 * counters + the rejected-rows artifact are accumulated as a side effect of the generator that feeds COPY, so
 * they are final once `copyRows` resolves (the pipeline has fully drained the generator by then).
 */
export async function bulkStage(input: BulkStageInput): Promise<BulkStageResult> {
  const { scope, job, fileStore } = input;
  const workspaceId = scope.workspaceId;
  const mapping = job.columnMapping as ColumnMapping;
  const sourceName = job.sourceName as SourceName;

  const source = await fileStore.getObjectStream(job.sourceFile);
  const rejectedRows: RejectedRow[] = [];
  let total = 0;
  let staged = 0;

  // The generator the COPY stream pulls. `total` indexes EVERY parsed data row (0-based) — the stable
  // source_row_num that chunk bands range over and that the ledger records as row_index (gaps where a row was
  // rejected). Rejected rows are recorded and skipped (never yielded → never staged).
  async function* stagingRows(): AsyncIterable<StagingRow> {
    for await (const raw of streamParseCsv(source)) {
      const rowIndex = total;
      total += 1;
      const verdict = validateRow(raw, mapping);
      if (!verdict.ok) {
        rejectedRows.push(...rejectedRowsFor(rowIndex, raw, verdict.reasons));
        continue;
      }
      let prepared: PreparedContact;
      try {
        // verdict.mapped === mapRow(raw, mapping); reusing it keeps the bulk hash/keys byte-identical to runImport.
        prepared = prepareContact(verdict.mapped);
      } catch (err) {
        // validateRow already guarantees an identity key, so this is defensive — surface it as a reject, not a throw.
        const reason = err instanceof Error ? err.message : String(err);
        rejectedRows.push({ row: rowIndex, field: null, reason, raw });
        continue;
      }
      const hash = contentHash({ mapped: verdict.mapped, sourceName });
      staged += 1;
      yield toStagingRow(rowIndex, workspaceId, prepared, hash, raw);
    }
  }

  await importStagingRepository.copyRows(job.id, stagingRows());
  const dedupedInFile = await importStagingRepository.dedupWithinFile(job.id);

  const rejected = new Set(rejectedRows.map((r) => r.row)).size;
  return { total, staged, rejected, dedupedInFile, rejectedRows };
}
