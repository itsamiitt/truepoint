// runImport.ts — the load-bearing per-workspace import pipeline (05 §3, ADR-0006). For each parsed row:
// map → normalize → derive blind index + content hash → encrypt PII → (in ONE withTenantTx) idempotency
// check → upsert account by domain → dedup-match the contact (email → linkedin → sales-nav) → insert or
// update → append exactly one source_imports provenance row → (when importing INTO a list, list-plan/03 §2.2)
// add the landed contact to the target list as a `list_members` row (added_via='import', source_import_id set),
// all inside the SAME per-row transaction. Returns the new-vs-matched-vs-skipped tally + the added-to-list
// count. Each row runs in its own tight transaction so one bad row never rolls back the whole import.

import { env } from "@leadwolf/config";
import {
  type ContactWriteValues,
  type Tx,
  accountRepository,
  contactRepository,
  evidenceRepository,
  listRepository,
  masterGraphRepository,
  sourceImportRepository,
  validationRuleRepository,
  withErTx,
  withTenantTx,
} from "@leadwolf/db";
import type {
  ColumnMapping,
  ConflictPolicy,
  ImportRowError,
  ImportRowOutcome,
  ImportSummary,
  ImportTarget,
  RejectedRow,
  SourceName,
} from "@leadwolf/types";
import { CONTACT_PROVENANCE_FIELDS, DEFAULT_CONFLICT_POLICY } from "@leadwolf/types";
import { writeAudit } from "../compliance/writeAudit.ts";
import { companyDomainKey } from "../enrichment/freemailDomains.ts";
import { markConflicts } from "../prospect/conflictDetect.ts";
import { planFieldWrite } from "../prospect/fieldProvenance.ts";
import { assertListInWorkspace } from "../prospect/lists.ts";
import { type ValidationRuleSpec, runValidationRules } from "../validation/index.ts";
import { type RawRow, mapRow } from "./columnMap.ts";
import { contentHash } from "./contentHash.ts";
import { prepareContact, type PreparedContact } from "./prepareContact.ts";
import { rejectLabel, rejectedRowsFor, validateRow } from "./validateRow.ts";

export interface RunImportInput {
  scope: { tenantId: string; workspaceId: string };
  importedByUserId?: string;
  sourceName: SourceName;
  sourceFile?: string;
  mapping: ColumnMapping;
  rows: RawRow[]; // already parsed (parseImportFile)
  /** How to resolve a match against an existing workspace contact (G-IMP-5). Defaults to `skip` (no overwrite). */
  conflictPolicy?: ConflictPolicy;
  /**
   * Optional "import into list" target (list-plan/03 §2.2, Phase 2). When set, every landed contact (created,
   * overwritten-match, AND a held-back duplicate / idempotent-skip that resolved to an existing workspace
   * contact) is added to this list as a `list_members` row with `added_via='import'` and `source_import_id`
   * pointing at the appended provenance row (null when no new provenance row was appended). The `listId` is
   * validated against the caller's workspace BEFORE any row runs — a foreign/absent id fails the whole import
   * (the client-supplied id is never trusted; list-plan D4). Absent = land in the overlay with no list linkage.
   */
  target?: ImportTarget;
}

/** The per-row landing outcome. `duplicate` = matched an existing contact and was held back under a `skip`
 *  policy (NOT applied); distinct from `skipped` (an idempotent content-hash re-import no-op). */
type RowLandingOutcome = ImportRowOutcome | "duplicate";

/**
 * The result of landing one row. `contactId` is the workspace contact the row RESOLVED to (the new contact for
 * `created`, the matched contact for `matched`/`duplicate`/`skipped`) — present whenever the row maps to a real
 * workspace contact, so the import-into-list path can add it as a member even when the row itself was a
 * duplicate/idempotent-skip. `sourceImportId` is the appended provenance row (only `created`/`matched` append
 * one; `duplicate`/`skipped` reuse the existing contact and append nothing → null). `addedToList` is whether a
 * NEW membership row was inserted this call (idempotent — false if the contact was already in the list).
 */
interface RowLanding {
  outcome: RowLandingOutcome;
  contactId: string | null;
  sourceImportId: string | null;
  addedToList: boolean;
}

/**
 * Add the landed contact to the import's target list (list-plan/03 §2.2) inside the SAME per-row transaction,
 * with `added_via='import'` and the appended provenance row id. Idempotent (ON CONFLICT DO NOTHING upstream):
 * a contact already in the list is a no-op. Returns whether a NEW membership row was created.
 *
 * The contactId is filtered through `visibleContactIds` first — exactly like the manual add path
 * (`addContactsToList`), which is the cross-workspace + soft-delete guard: it links only a LIVE
 * (deletedAt IS NULL) contact in the caller's workspace under RLS. This matters on the duplicate/skip paths,
 * where the matched contact may be a since-archived/DSAR-tombstoned row (the dedup lookups don't exclude
 * soft-deleted contacts) — re-adding such a contact would create a dangling member the masked read then hides.
 */
async function addLandedToList(
  tx: Tx,
  input: RunImportInput,
  listId: string,
  contactId: string,
  sourceImportId: string | null,
): Promise<boolean> {
  const visible = await listRepository.visibleContactIds(tx, [contactId]);
  if (visible.length === 0) return false; // soft-deleted/foreign contact — never link it
  const inserted = await listRepository.addMembers(tx, {
    tenantId: input.scope.tenantId,
    workspaceId: input.scope.workspaceId,
    listId,
    addedByUserId: input.importedByUserId ?? null,
    contactIds: visible,
    addedVia: "import",
    sourceImportId,
  });
  return inserted > 0;
}

/** The Layer-0 golden ids a landing row resolves to. Both null when resolution was skipped or failed. */
interface ResolvedMaster {
  masterPersonId: string | null;
  masterCompanyId: string | null;
}

const NO_MASTER: ResolvedMaster = { masterPersonId: null, masterCompanyId: null };

/**
 * Co-op-safe MATCH-AGAINST resolution for a LANDING row (PLAN_02 §1.4, ADR-0021): LINK the contact's identity
 * to an existing Layer-0 master person/company or co-op-safely MINT one, returning the bridge ids the overlay
 * write stamps onto `contacts.master_person_id` / `accounts.master_company_id`. Runs in its OWN transaction
 * under the least-privilege `leadwolf_er` role (`withErTx`) — a different role/connection than the per-row
 * `withTenantTx` overlay tx, because `leadwolf_app` has NO grant on the master_* tables (isolation by access
 * path, PLAN_02 RLS). The resolver input is identity + blind-index dedup keys ONLY — never a revealable PII
 * value. The company key is gated through `companyDomainKey` so a freemail/role domain (gmail.com) yields no
 * company key → no company mint (F4); it prefers the explicit account domain, falling back to the email's
 * domain. Resolution is NON-FATAL: the bridges are nullable in-flight-staging columns (PLAN_00 C4, ADR-0021),
 * so on any error we log and return both null, leaving the row to land with null bridges (backfilled later) —
 * a resolution failure must NEVER fail the row's landing.
 */
async function resolveMasterForLanding(prepared: PreparedContact): Promise<ResolvedMaster> {
  try {
    const registrableDomain =
      companyDomainKey(prepared.accountDomain) ?? companyDomainKey(prepared.values.emailDomain);
    const input = {
      linkedinPublicId: prepared.values.linkedinPublicId ?? undefined,
      emailBlindIndex: prepared.values.emailBlindIndex ?? undefined,
      emailDomain: prepared.values.emailDomain ?? undefined,
      registrableDomain,
      companyName: prepared.accountName,
    };
    const { masterPersonId, masterCompanyId } = await withErTx((tx2) =>
      masterGraphRepository.resolveForImport(tx2, input),
    );
    return { masterPersonId, masterCompanyId };
  } catch (err) {
    // In-flight staging: never fail the landing on a resolution error — land with null bridges (ADR-0021).
    console.error("[import] master resolution failed; landing with null bridges", err);
    return NO_MASTER;
  }
}

/**
 * I0 evidence dual-write (prospect-database-platform; audit P01), BEHIND INGESTION_EVIDENCE_ENABLED. Appends the
 * immutable source_records evidence row for this LANDED row + its match_links cluster membership, in their OWN
 * withErTx (the master-graph write role). NON-FATAL + idempotent (content-hash): a failure logs and never fails
 * the landing, and an identical re-ingest does not double-link. The shipped golden landing stays authoritative —
 * the survivorship projector reading this log is a SEPARATE, CI-parity-gated flip.
 */
async function recordImportEvidence(
  input: RunImportInput,
  raw: RawRow,
  hash: Uint8Array,
  resolved: ResolvedMaster,
  prepared: PreparedContact,
): Promise<void> {
  try {
    await withErTx(async (tx) => {
      const ev = await evidenceRepository.appendSourceRecord(tx, {
        sourceName: input.sourceName,
        contentHash: hash,
        rawData: raw,
        matchKeys: {
          emailDomain: prepared.values.emailDomain ?? undefined,
          linkedinPublicId: prepared.values.linkedinPublicId ?? undefined,
        },
        resolvedPersonId: resolved.masterPersonId,
        resolvedCompanyId: resolved.masterCompanyId,
      });
      if (!ev || !ev.created) return; // idempotent re-ingest → don't double-link
      if (resolved.masterPersonId) {
        await evidenceRepository.linkToCluster(tx, {
          entityType: "person",
          clusterId: resolved.masterPersonId,
          sourceRecordId: ev.id,
        });
        // Enqueue a survivorship re-projection for the cluster (I1 / Phase 05). The projector worker rebuilds the
        // golden record from the evidence log; until that worker + the authoritative flip ship, this is just a queue.
        await evidenceRepository.enqueueProjection(tx, {
          entityType: "person",
          clusterId: resolved.masterPersonId,
          reason: "evidence_added",
        });
      }
      if (resolved.masterCompanyId) {
        await evidenceRepository.linkToCluster(tx, {
          entityType: "company",
          clusterId: resolved.masterCompanyId,
          sourceRecordId: ev.id,
        });
        await evidenceRepository.enqueueProjection(tx, {
          entityType: "company",
          clusterId: resolved.masterCompanyId,
          reason: "evidence_added",
        });
      }
    });
  } catch (err) {
    console.error("[import] evidence dual-write failed (non-fatal; flag-gated)", err);
  }
}

async function importOneRow(
  tx: Tx,
  input: RunImportInput,
  raw: RawRow,
  prepared: PreparedContact,
  hash: Uint8Array,
  policy: ConflictPolicy,
): Promise<RowLanding> {
  const { tenantId, workspaceId } = input.scope;
  const listId = input.target?.listId;

  // Identical payload already imported into this workspace → no-op (idempotent re-import). The existing contact
  // is still added to the target list (membership is the point of the import) but no second provenance row is
  // appended — the prior import already recorded the lineage (list-plan/03 §2.2).
  const priorImport = await sourceImportRepository.findByContentHash(tx, workspaceId, hash);
  if (priorImport) {
    const addedToList = listId
      ? await addLandedToList(tx, input, listId, priorImport.contactId, null)
      : false;
    return {
      outcome: "skipped",
      contactId: priorImport.contactId,
      sourceImportId: null,
      addedToList,
    };
  }

  // ALWAYS look up the match first — even for keep_both. The overlay enforces ONE contact per identity key
  // per workspace via the partial unique indexes (workspace_id, email_blind_index) /
  // (workspace_id, linkedin_public_id) / (workspace_id, sales_nav_lead_id) — 03 §5/§11. A blind insert on an
  // existing identity would just throw a unique-constraint violation, so we resolve the conflict in app code.
  // Computed BEFORE the account upsert + master resolution so a held-back duplicate touches NEITHER (a row
  // that does not land never mints a master node nor stamps an account — resolve only on landing rows).
  const match = await contactRepository.findByDedupKeys(tx, workspaceId, prepared.dedupKeys);

  // G-IMP-5 conflict policy held-back DUPLICATE (skip/keep_both): keep the existing contact untouched; count
  // it as a duplicate (no provenance row appended), but still add it to the target list (the point of an
  // "import into list" is membership). This path does NOT land → no master resolution, no account upsert.
  //   - `keep_both` → a truly SEPARATE record can't exist in the overlay (one-per-identity-key), and
  //                   separate-record survivorship is ER's domain (30 §5, ADR-0021); until that lands,
  //                   keep_both holds the match back as a duplicate (NOT a silent overwrite) rather than
  //                   throwing a unique-constraint error on an insert that can never succeed.
  if (match && (policy === "skip" || policy === "keep_both")) {
    const addedToList = listId ? await addLandedToList(tx, input, listId, match.id, null) : false;
    return { outcome: "duplicate", contactId: match.id, sourceImportId: null, addedToList };
  }

  // ── LANDING ROW (created, or overwrite→matched) ──────────────────────────────────────────────────────────
  // Co-op-safe MATCH-AGAINST resolution runs BEFORE the overlay write, in its OWN `withErTx` tx (leadwolf_er) —
  // OUTSIDE this per-row `withTenantTx` (leadwolf_app has no master_* grant; PLAN_02 §1.4, ADR-0021). The
  // bridge ids are nullable in-flight staging, so a resolution failure leaves them null and the row still lands.
  const resolved = await resolveMasterForLanding(prepared);
  const { masterPersonId, masterCompanyId } = resolved;
  // I0 evidence dual-write (flag-off by default → no-op; audit P01). Additive + non-fatal; never affects the
  // golden landing below.
  if (env.INGESTION_EVIDENCE_ENABLED) await recordImportEvidence(input, raw, hash, resolved, prepared);

  let accountId: string | undefined;
  if (prepared.accountDomain) {
    accountId = await accountRepository.upsertByDomain(tx, {
      tenantId,
      workspaceId,
      name: prepared.accountName ?? prepared.accountDomain,
      domain: prepared.accountDomain,
      // Overlay → Layer-0 bridge (contacts.ts:50): set the account's golden company when ER resolved one.
      masterCompanyId: masterCompanyId ?? undefined,
    });
  }

  const values: ContactWriteValues = {
    ...prepared.values,
    tenantId,
    workspaceId,
    accountId: accountId ?? null,
    // Overlay → Layer-0 bridge (contacts.ts:112): only the uuid is added to the leadwolf_app write — the FK
    // referential check runs at owner privilege, so no master_* grant is needed. Nullable when unresolved.
    masterPersonId: masterPersonId ?? undefined,
  };

  // PLAN_03 §1.4 — the import-overwrite path respects the field-provenance pin (Phase 3 overlay), exactly like
  // enrichment: a user-pinned SCALAR profile field (jobTitle/department/…) must NOT be clobbered by a blind
  // last-writer-wins import. The SCALAR fields are the pin-protected subset of this row's write
  // (CONTACT_PROVENANCE_FIELDS); the non-scalar fields (email/phone/linkedin/sales-nav/master/account) are NOT
  // pin-gated and are written as before. Every scalar the import does write is stamped `{src:'import:<source>'}`.
  const scalarFields = Object.keys(prepared.values).filter((f) =>
    (CONTACT_PROVENANCE_FIELDS as readonly string[]).includes(f),
  );

  let contactId: string;
  let outcome: RowLandingOutcome;
  if (match) {
    // `overwrite` → update the existing contact, but plan the SCALAR write against its current provenance so a
    // pinned (user-corrected) scalar survives: drop every pinned scalar key from `values` (the import value must
    // not overwrite the user's correction), then stamp `import:<source>` provenance on the scalars we DO write.
    const existingProv = await contactRepository.getFieldProvenance(tx, match.id);
    const { writableFields, provenance } = planFieldWrite(existingProv, scalarFields, {
      src: `import:${input.sourceName}`,
    });
    for (const f of scalarFields) {
      if (!writableFields.has(f)) delete (values as unknown as Record<string, unknown>)[f];
    }
    // data-management #8 — flag TRUE cross-source conflicts on the scalars we overwrite. ADDITIVE + fully GUARDED:
    // any failure falls back to the plain provenance, so conflict detection can NEVER fail or alter the import.
    let mergedProvenance = provenance;
    try {
      const existingValues = await contactRepository.getScalarValues(tx, match.id);
      mergedProvenance = markConflicts({
        provenance,
        existingProvenance: existingProv,
        existingValues,
        incomingValues: prepared.values as unknown as Record<string, unknown>,
        writtenFields: writableFields,
        incomingSrc: `import:${input.sourceName}`,
      });
    } catch (err) {
      console.error("[import] conflict detection failed (non-fatal)", err);
    }
    values.fieldProvenance = mergedProvenance;
    await contactRepository.update(tx, match.id, values);
    contactId = match.id;
    outcome = "matched";
  } else {
    // A NEW contact has no pin to respect, but record a provenance baseline for the scalars it writes so a later
    // enrichment knows these came from this import (and may overwrite them — they are unpinned, `pin:false`).
    const { provenance } = planFieldWrite({}, scalarFields, { src: `import:${input.sourceName}` });
    values.fieldProvenance = provenance;
    contactId = await contactRepository.insert(tx, values);
    outcome = "created";
  }

  const sourceImportId = await sourceImportRepository.append(tx, {
    tenantId,
    workspaceId,
    contactId,
    importedByUserId: input.importedByUserId ?? null,
    sourceName: input.sourceName,
    sourceFile: input.sourceFile ?? null,
    rawData: raw,
    contentHash: hash,
  });

  // A landed row (created or overwritten match) joins the target list, linked to THIS import's provenance row.
  const addedToList = listId
    ? await addLandedToList(tx, input, listId, contactId, sourceImportId)
    : false;
  return { outcome, contactId, sourceImportId, addedToList };
}

/**
 * Load the ENABLED custom data-quality rules once for an import (database-management-research 06). FAIL-OPEN: a
 * rules-read hiccup must never block an import — the custom rules are an added quality gate, not a correctness
 * invariant — so on error we log and enforce nothing. Built-in checks are deliberately NOT loaded here (they would
 * reject LinkedIn-only / nameless rows the pipeline otherwise accepts); only staff-authored custom rules apply.
 */
async function loadEnabledValidationRules(scope: RunImportInput["scope"]): Promise<ValidationRuleSpec[]> {
  try {
    const rows = await withTenantTx(scope, (tx) => validationRuleRepository.listEnabledForImport(tx));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      field: r.field,
      checkType: r.checkType as ValidationRuleSpec["checkType"],
      config: (r.config ?? {}) as ValidationRuleSpec["config"],
    }));
  } catch (err) {
    console.error("[import] failed to load validation rules; proceeding without them", err);
    return [];
  }
}

/**
 * Run a full per-workspace import and return the accounting summary (30 §4): created / matched / skipped /
 * duplicates / rejected + addedToList, plus the rejected-rows artifact. A row that fails validation is REJECTED
 * (collected with per-field reasons for the downloadable error file, G-IMP-1) — it never reaches the DB; a row
 * that matches under a `skip` conflict policy is a DUPLICATE (held back); everything else lands. When an
 * `input.target` list is set (list-plan/03 §2.2) every contact a row resolves to (created/matched/duplicate/
 * skipped) is added to that list (`added_via='import'`); the target is validated against the caller's workspace
 * up-front, so a foreign/absent list id fails the whole import before any row is processed (list-plan D4).
 */
export async function runImport(input: RunImportInput): Promise<ImportSummary> {
  const policy: ConflictPolicy = input.conflictPolicy ?? DEFAULT_CONFLICT_POLICY;
  // Trust boundary: validate the import-into-list target against the caller's workspace BEFORE any row runs.
  // Reuses the same guard the manual add path + the API edge use (assertListInWorkspace → NotFoundError on a
  // foreign/absent id), so a bad list id fails the whole import fast and consistently — the client id is never
  // trusted (list-plan D4). No-op when there is no target.
  if (input.target) {
    await assertListInWorkspace({ scope: input.scope, listId: input.target.listId });
  }

  // The global custom data-quality rules (database-management-research 06), loaded ONCE. Empty unless staff have
  // authored rules → no behaviour change for an import with none. Reject-on-fail, additive to validateRow below.
  const validationRules = await loadEnabledValidationRules(input.scope);

  const errors: ImportRowError[] = [];
  const rejectedRows: RejectedRow[] = [];
  // A per-import reject breakdown keyed by a STABLE, NON-PII label (never a row value) — one bump per rejected row
  // (its primary reason), so the histogram sums to the distinct rejected-row count. Surfaced to staff on the import
  // drill-down (database-management-research G08). Categorized at the SOURCE below so a free-text catch-path message
  // (which may embed a value) is bucketed as a generic "Processing error", never surfaced verbatim.
  const rejectHistogram: Record<string, number> = {};
  const bumpReject = (field: string | null, kind: "validation" | "rule" | "error"): void => {
    const label = rejectLabel(field, kind);
    rejectHistogram[label] = (rejectHistogram[label] ?? 0) + 1;
  };
  let created = 0;
  let matched = 0;
  let skipped = 0;
  let duplicates = 0;
  let addedToList = 0;

  for (let i = 0; i < input.rows.length; i++) {
    const raw = input.rows[i]!;

    // Pre-flight validation = the same verdict the preview uses, so a row rejected in the preview is rejected
    // here with identical per-field reasons (the rejected-rows artifact). Rejected rows never touch the DB.
    const verdict = validateRow(raw, input.mapping);
    if (!verdict.ok) {
      rejectedRows.push(...rejectedRowsFor(i, raw, verdict.reasons));
      bumpReject(verdict.reasons[0]?.field ?? null, "validation");
      errors.push({ row: i, message: verdict.reasons[0]?.reason ?? "Row rejected." });
      continue;
    }

    // Staff custom data-quality rules (reject-on-fail, database-management-research 06): run them over the mapped
    // row; any failure rejects the row with its per-field reason (built-ins are NOT enforced here). A failed row
    // never reaches the DB — identical treatment to a validateRow rejection.
    if (validationRules.length > 0) {
      const ruleFailures = runValidationRules(verdict.mapped as Record<string, unknown>, validationRules);
      if (ruleFailures.length > 0) {
        rejectedRows.push(
          ...ruleFailures.map((f) => ({
            row: i,
            field: f.field,
            reason: f.message,
            code: "validation_rule_failed" as const,
            raw,
          })),
        );
        bumpReject(ruleFailures[0]!.field, "rule");
        errors.push({ row: i, message: ruleFailures[0]!.message });
        continue;
      }
    }

    try {
      const mapped = mapRow(raw, input.mapping);
      const prepared = prepareContact(mapped);
      const hash = contentHash({ mapped, sourceName: input.sourceName });
      const landing = await withTenantTx(input.scope, (tx) =>
        importOneRow(tx, input, raw, prepared, hash, policy),
      );
      if (landing.outcome === "created") created++;
      else if (landing.outcome === "matched") matched++;
      else if (landing.outcome === "duplicate") duplicates++;
      else skipped++;
      if (landing.addedToList) addedToList++;
    } catch (err) {
      // A DB/constraint failure after validation passed: surface it as a reject (it did not land). The typed
      // code is the BUCKETED `processing_error` — the free-text `message` (which may embed a value) is NEVER
      // what the ledger token or the error report exposes (13 §3.3); it survives only in the gated repair CSV.
      const message = err instanceof Error ? err.message : String(err);
      rejectedRows.push({ row: i, field: null, reason: message, code: "processing_error", raw });
      bumpReject(null, "error");
      errors.push({ row: i, message });
    }
  }

  // Customer-visible audit (list-plan/03 §2.2): one member.add row per import carrying the count that newly
  // joined the list (not per contact — a 10k-row import must not write 10k audit rows). Its own tx so it
  // commits regardless of which per-row txs landed; skipped when the import had no list target or added nobody.
  if (input.target && addedToList > 0) {
    await withTenantTx(input.scope, (tx) =>
      writeAudit(tx, {
        tenantId: input.scope.tenantId,
        workspaceId: input.scope.workspaceId,
        actorUserId: input.importedByUserId ?? null,
        action: "member.add",
        entityType: "list",
        entityId: input.target!.listId,
        metadata: { affected: addedToList, via: "import" },
      }),
    );
  }

  // `rejected` is the count of distinct rejected INPUT rows (rejectedRows may hold >1 reason per row).
  const rejected = new Set(rejectedRows.map((r) => r.row)).size;
  return {
    total: input.rows.length,
    created,
    matched,
    skipped,
    rejected,
    duplicates,
    addedToList,
    errors,
    rejectedRows,
    rejectHistogram,
  };
}
