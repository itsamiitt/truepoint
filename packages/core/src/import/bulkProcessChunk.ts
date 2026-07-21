// bulkProcessChunk.ts — the per-chunk MERGE: the THROUGHPUT CORE of the bulk COPY-staging import (15-bulk-import-
// design §2, backlog #2, phase 5). It produces byte-identical LANDING results to the synchronous per-row
// runImport (importOneRow) — just BATCHED: today's "1 tx + 3 SELECTs per row" collapses into ONE withTenantTx
// plus a handful of batched statements per ~10k-row chunk, with master resolution in ONE nested withErTx.
//
// ── PARITY WITH runImport.importOneRow (point-by-point) ──────────────────────────────────────────────────────
//  • dedup match — findByDedupKeysBatch uses the SAME email→linkedin→sales-nav precedence as findByDedupKeys.
//  • conflict policy — a match under `skip`/`keep_both` is a held-back DUPLICATE (existing row untouched); a
//    match under `overwrite` is `matched` (update); no match is `created` (insert). Identical to importOneRow.
//  • master resolution — resolveForImportBatch runs the UNCHANGED single-row resolve per LANDING row inside ONE
//    withErTx (the co-op-safe MINT boundary is byte-identical). Non-fatal like runImport, but at CHUNK
//    granularity: a resolver-tx failure lands the whole chunk with NULL bridges (vs per-row) — documented below.
//  • account upsert — upsertByDomainBatch is the batched mirror of upsertByDomain (same bridge-null + name rules).
//  • pin-aware overwrite — getFieldProvenanceBatch + planFieldWrite, the SAME canonical pin rule + the SAME
//    `import:<source>` provenance stamp; pinned scalars are dropped from the update exactly as importOneRow does.
//  • conflict marking — getScalarValuesBatch + markConflicts (data-management #8), the SAME sticky `cf` rule as
//    importOneRow (different src + different NORMALIZED value); guarded so it can never fail or alter the merge.
//  • provenance — appendBatch writes one source_imports row per landing row, idempotent via ON CONFLICT
//    (workspace_id, content_hash) DO NOTHING (the bulk equivalent of runImport's content-hash idempotency).
//  • list membership — every contact a row RESOLVES to (created + matched + held-back duplicate) is added to the
//    target list, visible-id-filtered first (the cross-workspace + soft-delete guard runImport.addLandedToList uses).
//
// ── DOCUMENTED DIVERGENCES (forced by the batch model / the available primitives) ────────────────────────────
//  1. NO per-row findByContentHash pre-check ⇒ the bulk merge does NOT emit runImport's `skipped` outcome. A
//     prior-identical-payload re-import resolves instead as `matched`/`duplicate` (the contact already exists →
//     dedup matches it) and appendBatch's ON CONFLICT keeps provenance idempotent. This is the design's idempotency
//     model (15 §2: "content_hash + already-committed rows resolve as matches"); composing the existing batch
//     primitives forbids a per-row content-hash round-trip.
//  2. list members link by contact id with source_import_id = null (appendBatch returns no per-row ids — see its
//     comment), whereas runImport links each member to its exact provenance row. End membership is identical.
//  3. resolver failure granularity is the chunk, not the row (one withErTx per chunk).
//
// IDEMPOTENT ON RETRY: the whole merge — contacts, provenance, list members, ledger, counter deltas, and the
// chunk's terminal status — commits in ONE withTenantTx, so a failed attempt rolls back wholesale and a retry
// re-reads the same pending rows. A chunk already `completed` is skipped (re-merge would double-count). NOTE for
// the phase-6 worker: call finalizeIfLastChunk ONLY when `processed === true` (a real completion) so completed_chunks
// is incremented exactly once. NOTE on pooling: the nested withErTx holds a 2nd pool connection per chunk — size
// worker concurrency against the pool max (mirrors runImport's per-row withErTx).

import {
  type AccountUpsertInput,
  type ContactWriteValues,
  type DedupKeys,
  type ImportJobRowInsert,
  type ResolveForImportInput,
  type ResolveForImportResult,
  type SourceImportInput,
  type StagingRow,
  accountRepository,
  contactRepository,
  importJobRepository,
  importStagingRepository,
  listRepository,
  masterGraphRepository,
  sourceImportRepository,
  withErTx,
  withTenantTx,
} from "@leadwolf/db";
import {
  type BulkImportScope,
  type ConflictPolicy,
  type FieldProvenanceMap,
  type SourceName,
  CONTACT_PROVENANCE_FIELDS,
} from "@leadwolf/types";
import { companyDomainKey } from "../enrichment/freemailDomains.ts";
import { markConflicts } from "../prospect/conflictDetect.ts";
import { planFieldWrite } from "../prospect/fieldProvenance.ts";
import type { PreparedValues } from "./prepareContact.ts";

export interface BulkProcessChunkInput {
  scope: BulkImportScope;
  jobId: string;
  chunkId: string;
}

export interface BulkProcessChunkResult {
  /** false = idempotent skip (the chunk was already `completed`); true = this call merged + finalized the chunk. */
  processed: boolean;
  created: number;
  matched: number;
  duplicate: number;
  processedRows: number;
}

type RowKind = "created" | "matched" | "duplicate";

const NO_MASTER: ResolveForImportResult = { masterPersonId: null, masterCompanyId: null };

/** Reconstruct the prepared write values from a staged row — the inverse of bulkStage.toStagingRow. Email/phone
 *  fields are OMITTED (undefined) when absent, so an overwrite never wipes an existing channel with null (matching
 *  runImport, where prepareContact only sets them when present and definedOnly drops undefined on update). The
 *  scalar profile fields are always present (value or null), exactly like prepareContact's `?? null`. */
function stagedToValues(r: StagingRow): PreparedValues {
  const values: PreparedValues = {
    firstName: r.firstName,
    lastName: r.lastName,
    jobTitle: r.jobTitle,
    seniorityLevel: r.seniorityLevel,
    department: r.department,
    linkedinUrl: r.linkedinUrl,
    linkedinPublicId: r.linkedinPublicId,
    salesNavProfileUrl: r.salesNavProfileUrl,
    salesNavLeadId: r.salesNavLeadId,
    locationCountry: r.locationCountry,
    locationCity: r.locationCity,
  };
  if (r.emailEnc !== null) {
    values.emailEnc = r.emailEnc;
    values.emailBlindIndex = r.emailBlindIndex;
    values.emailDomain = r.emailDomain;
  }
  if (r.phoneEnc !== null) values.phoneEnc = r.phoneEnc;
  return values;
}

function stagedDedupKeys(r: StagingRow): DedupKeys {
  return {
    emailBlindIndex: r.emailBlindIndex ?? undefined,
    linkedinPublicId: r.linkedinPublicId ?? undefined,
    salesNavLeadId: r.salesNavLeadId ?? undefined,
  };
}

/** The MATCH-AGAINST resolver input for a landing row — identical to runImport.resolveMasterForLanding's input
 *  (company key prefers the account domain, falls back to the email domain; both gated through companyDomainKey). */
function resolverInputOf(r: StagingRow): ResolveForImportInput {
  const registrableDomain =
    companyDomainKey(r.accountDomain ?? undefined) ?? companyDomainKey(r.emailDomain ?? undefined);
  return {
    linkedinPublicId: r.linkedinPublicId ?? undefined,
    emailBlindIndex: r.emailBlindIndex ?? undefined,
    emailDomain: r.emailDomain ?? undefined,
    registrableDomain,
    companyName: r.accountName ?? undefined,
  };
}

export async function bulkProcessChunk(
  input: BulkProcessChunkInput,
): Promise<BulkProcessChunkResult> {
  const { scope, jobId, chunkId } = input;
  const { tenantId, workspaceId } = scope;

  // Load the control + chunk rows (RLS-scoped). The staging band is read SEPARATELY on the owner connection.
  const meta = await withTenantTx(scope, async (tx) => {
    const job = await importJobRepository.getJobSystem(tx, jobId);
    if (!job) return null;
    const chunks = await importJobRepository.listChunks(tx, jobId);
    const chunk = chunks.find((c) => c.id === chunkId) ?? null;
    return { job, chunk };
  });
  if (!meta || !meta.job || !meta.chunk) {
    throw new Error(`bulkProcessChunk: job/chunk not found (job=${jobId} chunk=${chunkId})`);
  }
  const job = meta.job;
  const chunk = meta.chunk;

  // Idempotent skip: a `completed` chunk committed its merge + status atomically — re-running would double-count.
  if (chunk.status === "completed") {
    return { processed: false, created: 0, matched: 0, duplicate: 0, processedRows: 0 };
  }

  const policy = (job.conflictPolicy as ConflictPolicy) ?? "skip";
  const sourceName = job.sourceName as SourceName;
  const src = `import:${sourceName}`;
  const targetListId = job.targetListId;
  const importedByUserId = job.createdByUserId ?? null;
  const sourceFile = job.sourceFile ?? null;

  // Staging read: owner connection (non-RLS) with the EXPLICIT workspace_id predicate (access-path isolation).
  const staged = await importStagingRepository.readChunkBand(
    jobId,
    workspaceId,
    chunk.rowStart,
    chunk.rowEnd,
  );

  // Empty band (all rows here were rejected/deduped, or none) → just mark the chunk terminal.
  if (staged.length === 0) {
    await withTenantTx(scope, (tx) =>
      importJobRepository.updateChunk(tx, chunkId, {
        status: "completed",
        processedRows: 0,
        completedAt: new Date(),
      }),
    );
    return { processed: true, created: 0, matched: 0, duplicate: 0, processedRows: 0 };
  }

  return withTenantTx(scope, async (tx) => {
    // 1) Batched against-existing dedup (index-aligned to `staged`).
    const matches = await contactRepository.findByDedupKeysBatch(
      tx,
      workspaceId,
      staged.map(stagedDedupKeys),
    );

    // 2) Classify each row (mirror importOneRow): match+skip/keep_both → duplicate (held back); match+overwrite
    //    → matched (update); no match → created (insert).
    const kinds: RowKind[] = staged.map((_, i) => {
      const matchId = matches[i]?.id ?? null;
      if (matchId && (policy === "skip" || policy === "keep_both")) return "duplicate";
      if (matchId) return "matched";
      return "created";
    });
    const landingIdx: number[] = [];
    for (let i = 0; i < staged.length; i += 1) {
      if (kinds[i] !== "duplicate") landingIdx.push(i);
    }

    // 3) Master resolution for LANDING rows only — ONE withErTx. Non-fatal at chunk granularity: a resolver-tx
    //    failure lands every row with null bridges (backfilled later), never failing the chunk (ADR-0021).
    const resolverInputs: ResolveForImportInput[] = landingIdx.map((i) => resolverInputOf(staged[i]!));
    let resolved: ResolveForImportResult[];
    try {
      resolved = resolverInputs.length
        ? await withErTx((erTx) => masterGraphRepository.resolveForImportBatch(erTx, resolverInputs))
        : [];
    } catch (err) {
      console.error("[bulk-import] master resolution failed for chunk; landing with null bridges", err);
      resolved = resolverInputs.map(() => NO_MASTER);
    }
    const resolvedByIdx = new Map<number, ResolveForImportResult>();
    landingIdx.forEach((i, li) => resolvedByIdx.set(i, resolved[li] ?? NO_MASTER));

    // 4) Account upsert (batched) for landing rows that carry a domain.
    const accountInputs: AccountUpsertInput[] = [];
    for (const i of landingIdx) {
      const r = staged[i]!;
      if (!r.accountDomain) continue;
      accountInputs.push({
        tenantId,
        workspaceId,
        name: r.accountName ?? r.accountDomain,
        domain: r.accountDomain,
        masterCompanyId: resolvedByIdx.get(i)?.masterCompanyId ?? undefined,
      });
    }
    const accountMap = accountInputs.length
      ? await accountRepository.upsertByDomainBatch(tx, accountInputs)
      : new Map<string, string>();

    // 5) Field provenance for the matched (overwrite) rows — the pin-aware overwrite read.
    const matchedIds = landingIdx
      .filter((i) => kinds[i] === "matched")
      .map((i) => matches[i]!.id);
    const provMap = matchedIds.length
      ? await contactRepository.getFieldProvenanceBatch(tx, matchedIds)
      : new Map<string, FieldProvenanceMap>();
    // 5b) Existing scalar VALUES for the matched rows — the TRUE cross-source conflict-detection read
    //     (data-management #8; the batched mirror of runImport's markConflicts wiring). GUARDED: a read failure
    //     degrades to "no conflicts detected this chunk" (empty map) — it can never fail or alter the merge.
    let scalarsMap = new Map<string, Record<string, unknown>>();
    try {
      if (matchedIds.length) {
        scalarsMap = await contactRepository.getScalarValuesBatch(tx, matchedIds);
      }
    } catch (err) {
      console.error("[bulk-import] conflict-detect scalar read failed (non-fatal)", err);
    }

    // 6) Build inserts + updates exactly like importOneRow's landing branch.
    const insertValues: ContactWriteValues[] = [];
    const insertIdx: number[] = [];
    const updates: Array<{ id: string; values: Partial<ContactWriteValues> }> = [];
    for (const i of landingIdx) {
      const r = staged[i]!;
      const accountId = r.accountDomain ? accountMap.get(r.accountDomain) ?? null : null;
      const baseValues = stagedToValues(r);
      const scalarFields = Object.keys(baseValues).filter((f) =>
        (CONTACT_PROVENANCE_FIELDS as readonly string[]).includes(f),
      );
      const values: ContactWriteValues = {
        ...baseValues,
        tenantId,
        workspaceId,
        accountId,
        masterPersonId: resolvedByIdx.get(i)?.masterPersonId ?? undefined,
      };
      if (kinds[i] === "created") {
        const { provenance } = planFieldWrite({}, scalarFields, { src });
        values.fieldProvenance = provenance;
        insertValues.push(values);
        insertIdx.push(i);
      } else {
        const matchId = matches[i]!.id;
        const existingProv = provMap.get(matchId) ?? {};
        const { writableFields, provenance } = planFieldWrite(existingProv, scalarFields, {
          src,
        });
        for (const f of scalarFields) {
          if (!writableFields.has(f)) delete (values as unknown as Record<string, unknown>)[f];
        }
        // data-management #8 — flag TRUE cross-source conflicts on the scalars this overwrite stamps (the SAME
        // markConflicts rule as importOneRow: different src + different NORMALIZED value; sticky; pure).
        values.fieldProvenance = markConflicts({
          provenance,
          existingProvenance: existingProv,
          existingValues: scalarsMap.get(matchId) ?? {},
          incomingValues: baseValues as unknown as Record<string, unknown>,
          writtenFields: writableFields,
          incomingSrc: src,
        });
        updates.push({ id: matchId, values });
      }
    }
    const inserted = insertValues.length ? await contactRepository.insertBatch(tx, insertValues) : [];
    if (updates.length) await contactRepository.updateBatch(tx, updates);

    // 7) Resolve the contact id each staged row landed on / matched.
    const contactIdByIdx = new Map<number, string>();
    insertIdx.forEach((i, k) => contactIdByIdx.set(i, inserted[k]!.id));
    for (let i = 0; i < staged.length; i += 1) {
      if (kinds[i] === "matched" || kinds[i] === "duplicate") {
        contactIdByIdx.set(i, matches[i]!.id);
      }
    }

    // 8) Provenance — one source_imports row per LANDING row (created + matched), idempotent on content_hash.
    const provenanceInputs: SourceImportInput[] = landingIdx.map((i) => {
      const r = staged[i]!;
      return {
        tenantId,
        workspaceId,
        contactId: contactIdByIdx.get(i)!,
        importedByUserId,
        sourceName,
        sourceFile,
        rawData: r.rawData,
        contentHash: r.contentHash,
      };
    });
    if (provenanceInputs.length) await sourceImportRepository.appendBatch(tx, provenanceInputs);

    // 9) List membership — every contact a row resolves to (created + matched + held-back duplicate), filtered to
    //    the visible (live, in-workspace) subset first (runImport.addLandedToList's guard), linked added_via=import.
    if (targetListId) {
      const ids = Array.from(
        new Set(staged.map((_, i) => contactIdByIdx.get(i)).filter((id): id is string => Boolean(id))),
      );
      const visible = await listRepository.visibleContactIds(tx, ids);
      if (visible.length) {
        await listRepository.addMembers(tx, {
          tenantId,
          workspaceId,
          listId: targetListId,
          addedByUserId: importedByUserId,
          contactIds: visible,
          addedVia: "import",
          sourceImportId: null,
        });
      }
    }

    // 10) Per-row ledger (audit pointers; no FK).
    const ledger: ImportJobRowInsert[] = staged.map((r, i) => {
      const contactId = contactIdByIdx.get(i) ?? null;
      const entry: ImportJobRowInsert = {
        jobId,
        chunkId,
        rowIndex: r.sourceRowNum,
        workspaceId,
        input: r.rawData,
        // `RowKind` (created|matched|duplicate) is a subset of the ledger outcome enum (BulkImportRowOutcome, via
        // ImportJobRowInsert["outcome"]) — cast to the column's type; the DB CHECK admits all three values.
        outcome: kinds[i] as ImportJobRowInsert["outcome"],
      };
      if (kinds[i] === "created") {
        entry.createdContactId = contactId;
      } else if (kinds[i] === "matched") {
        entry.matchedContactId = contactId;
        entry.updatedContactId = contactId;
      } else {
        entry.matchedContactId = contactId;
      }
      return entry;
    });
    await importJobRepository.insertJobRows(tx, ledger);

    // 11) Atomic counter deltas + terminal chunk status (committed with the merge above).
    const created = kinds.filter((k) => k === "created").length;
    const matched = kinds.filter((k) => k === "matched").length;
    const duplicate = kinds.filter((k) => k === "duplicate").length;
    await importJobRepository.updateJobProgress(tx, jobId, {
      rowsCreated: created,
      rowsMatched: matched,
      rowsDuplicate: duplicate,
    });
    await importJobRepository.updateChunk(tx, chunkId, {
      status: "completed",
      processedRows: staged.length,
      completedAt: new Date(),
    });

    return { processed: true, created, matched, duplicate, processedRows: staged.length };
  });
}
