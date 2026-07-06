// draftPreview.ts — the S-I8 FULL-PASS preview projection (import-redesign 08 §4): given the draft's
// parsed rows + its saved mapping, one bounded pass produces (a) the NON-PII `preview_summary` the route
// caches on the draft row — total / valid / rejected / wouldCreate / wouldUpdate / duplicateInFile, the
// reject-code histogram, and the per-column feedback block (counts + codes + sample LINE NUMBERS, never a
// row value) — and (b) a BOUNDED sample of rejected rows with typed reasons, returned to the uploader and
// NEVER persisted. Builds ON the shipped primitives, not beside them: `validateRow` is the one verdict
// (preview and import can never disagree), `identitySignature` is the within-file dedup key (first
// occurrence valid, later collisions duplicate — buildImportPreview's exact rule), and the against-existing
// wouldCreate/wouldUpdate split rides `contactRepository.findByDedupKeysBatch` — the SAME email → linkedin
// → sales-nav precedence the engines match on (15 §2), batched in bounded slices. The caller bounds the
// scan itself (the fast-path routing pair, 08 §1/12 §5) and supplies an RLS-scoped tx (withTenantTx), so
// every lookup is workspace-walled at the database.
//
// wouldCreate/wouldUpdate are MATCH-BASED (Attio's effect preview, 03 §1.1 [85]): a matched row projects
// as an update, an unmatched one as a create — mode-specific outcomes (`update_only` misses landing as
// `skipped`) stay the engine's; the projection shows the file's effect under the default updating modes.
//
// Histogram keys are the TYPED reject codes (importReject.ts — the 08 §4 machine-readable vocabulary the
// preview/ledger/artifacts share), not the human `rejectLabel` strings the terminal `reject_histogram`
// carries (the shipped-labels drift, doc 16 S-I7 row) — both are non-PII by construction.

import { type DedupKeys, type Tx, contactRepository } from "@leadwolf/db";
import type {
  ColumnMapping,
  ImportPreviewColumnFeedback,
  ImportPreviewSummary,
  RejectedRow,
} from "@leadwolf/types";
import { blindIndex } from "./blindIndex.ts";
import type { RawRow } from "./columnMap.ts";
import { type RowIdentity, identitySignature, rejectedRowsFor, validateRow } from "./validateRow.ts";

/** Default cap on rejected rows sampled into the response — buildImportPreview's shipped bound. */
const DEFAULT_SAMPLE_LIMIT = 50;
/** Sample LINE NUMBERS kept per column in the feedback block (08 §4 — pointers, never values). */
const PER_COLUMN_SAMPLE_LINES = 5;
/** Dedup-lookup slice size: bounds each IN-list SELECT (≤ 3 per slice — the bulkProcessChunk posture). */
const DEDUP_LOOKUP_BATCH = 1000;

export interface DraftPreviewOptions {
  /** Max rejected rows in `sampleRejectedRows` (default 50). The summary always covers the FULL pass. */
  sampleLimit?: number;
}

export interface DraftPreviewResult {
  /** The non-PII projection — safe to cache on the control row as `preview_summary`. */
  summary: ImportPreviewSummary;
  /** Bounded, transient reject sample (typed code + reason + the offending raw row). NEVER persisted. */
  sampleRejectedRows: RejectedRow[];
}

/** Per-column accumulation state for the 08 §4 feedback block. */
interface ColumnTally {
  failures: number;
  codeCounts: Map<string, number>;
  sampleLines: number[];
}

/** Map a first-occurrence row identity to the repository's dedup-key shape (email key → blind index). */
function toDedupKeys(identity: RowIdentity): DedupKeys {
  return {
    emailBlindIndex: identity.emailKey ? blindIndex(identity.emailKey) : undefined,
    linkedinPublicId: identity.linkedinPublicId,
    salesNavLeadId: identity.salesNavLeadId,
  };
}

/**
 * The full-pass draft preview. One in-memory pass over `rows` (the caller has already bounded the file to
 * the fast-path pair) + ⌈valid/1000⌉ batched dedup lookups under the caller's RLS tx. Deterministic for a
 * given file + mapping + dataset.
 */
export async function buildDraftPreviewSummary(
  tx: Tx,
  workspaceId: string,
  rows: RawRow[],
  mapping: ColumnMapping,
  options: DraftPreviewOptions = {},
): Promise<DraftPreviewResult> {
  const sampleLimit = options.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;

  let rejected = 0;
  let duplicateInFile = 0;
  const rejectHistogram: Record<string, number> = {};
  const perColumn = new Map<string, ColumnTally>();
  const sampleRejectedRows: RejectedRow[] = [];
  const seen = new Set<string>();
  /** First-occurrence valid identities, in row order — the wouldCreate/wouldUpdate lookup input. */
  const validIdentities: RowIdentity[] = [];

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i]!;
    const verdict = validateRow(raw, mapping);
    if (!verdict.ok) {
      rejected++;
      for (const reason of verdict.reasons) {
        // Histogram + feedback key by the TYPED code / the CANONICAL field ref — non-PII by construction.
        rejectHistogram[reason.code] = (rejectHistogram[reason.code] ?? 0) + 1;
        const column = reason.field ?? "(row)";
        let tally = perColumn.get(column);
        if (!tally) {
          tally = { failures: 0, codeCounts: new Map(), sampleLines: [] };
          perColumn.set(column, tally);
        }
        tally.failures++;
        tally.codeCounts.set(reason.code, (tally.codeCounts.get(reason.code) ?? 0) + 1);
        if (tally.sampleLines.length < PER_COLUMN_SAMPLE_LINES) tally.sampleLines.push(i);
      }
      if (sampleRejectedRows.length < sampleLimit) {
        sampleRejectedRows.push(...rejectedRowsFor(i, raw, verdict.reasons));
      }
      continue;
    }
    // Within-file dedup: first occurrence is valid, later collisions duplicate (buildImportPreview's rule;
    // a valid row always carries ≥1 identity key, so the signature is always defined here).
    const sig = identitySignature(verdict.identity);
    if (sig && seen.has(sig)) {
      duplicateInFile++;
      continue;
    }
    if (sig) seen.add(sig);
    validIdentities.push(verdict.identity);
  }

  // Against-existing projection: batched, bounded lookups on the SAME ladder the engines match with.
  let wouldUpdate = 0;
  for (let start = 0; start < validIdentities.length; start += DEDUP_LOOKUP_BATCH) {
    const slice = validIdentities.slice(start, start + DEDUP_LOOKUP_BATCH).map(toDedupKeys);
    const matches = await contactRepository.findByDedupKeysBatch(tx, workspaceId, slice);
    for (const m of matches) if (m) wouldUpdate++;
  }
  const valid = validIdentities.length;
  const wouldCreate = valid - wouldUpdate;

  const perColumnOut: ImportPreviewColumnFeedback[] = [...perColumn.entries()].map(
    ([column, tally]) => {
      let dominant: string | null = null;
      let best = 0;
      for (const [code, count] of tally.codeCounts) {
        if (count > best) {
          best = count;
          dominant = code;
        }
      }
      return {
        column,
        parseFailures: tally.failures,
        dominantRejectCode: dominant,
        sampleLines: tally.sampleLines,
      };
    },
  );

  return {
    summary: {
      total: rows.length,
      valid,
      rejected,
      wouldCreate,
      wouldUpdate,
      duplicateInFile,
      rejectHistogram,
      perColumn: perColumnOut,
    },
    sampleRejectedRows,
  };
}
