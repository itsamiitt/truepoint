// runImport.ts — the load-bearing per-workspace import pipeline (05 §3, ADR-0006). For each parsed row:
// map → normalize → derive blind index + content hash → encrypt PII → (in ONE withTenantTx) idempotency
// check → upsert account by domain → dedup-match the contact (email → linkedin → sales-nav) → insert or
// update → append exactly one source_imports provenance row → (when importing INTO a list, list-plan/03 §2.2)
// add the landed contact to the target list as a `list_members` row (added_via='import', source_import_id set),
// all inside the SAME per-row transaction. Returns the new-vs-matched-vs-skipped tally + the added-to-list
// count. Each row runs in its own tight transaction so one bad row never rolls back the whole import.

import {
  type ContactWriteValues,
  type DedupKeys,
  type Tx,
  accountRepository,
  contactRepository,
  listRepository,
  sourceImportRepository,
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
import { DEFAULT_CONFLICT_POLICY } from "@leadwolf/types";
import { writeAudit } from "../compliance/writeAudit.ts";
import { assertListInWorkspace } from "../prospect/lists.ts";
import { blindIndex } from "./blindIndex.ts";
import { type MappedRow, type RawRow, mapRow } from "./columnMap.ts";
import { contentHash } from "./contentHash.ts";
import { encryptPii } from "./encryptPii.ts";
import {
  emailDomainOf,
  linkedinPublicIdOf,
  normalizeDomain,
  normalizeEmailForIndex,
  normalizeEmailForStorage,
  normalizeText,
} from "./normalize.ts";
import { rejectedRowsFor, validateRow } from "./validateRow.ts";

const SENIORITY = new Set(["c_suite", "vp", "director", "manager", "ic", "other"]);

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

type PreparedValues = Omit<ContactWriteValues, "tenantId" | "workspaceId" | "accountId">;

interface PreparedContact {
  values: PreparedValues;
  dedupKeys: DedupKeys;
  accountName?: string;
  accountDomain?: string;
}

function coerceSeniority(raw: string | undefined): string | null {
  const v = normalizeText(raw)
    ?.toLowerCase()
    .replace(/[\s-]+/g, "_");
  return v && SENIORITY.has(v) ? v : null;
}

/** Pure preparation: normalize + encrypt + derive keys. Throws if the row carries no identity key. */
function prepareContact(mapped: MappedRow): PreparedContact {
  const storageEmail = normalizeEmailForStorage(mapped.email);
  const linkedinPublicId = linkedinPublicIdOf(mapped.linkedinPublicId ?? mapped.linkedinUrl);
  const salesNavLeadId = normalizeText(mapped.salesNavLeadId);
  if (!storageEmail && !linkedinPublicId && !salesNavLeadId) {
    throw new Error("Row has no email, LinkedIn, or Sales Navigator identifier.");
  }

  const values: PreparedValues = {
    firstName: normalizeText(mapped.firstName) ?? null,
    lastName: normalizeText(mapped.lastName) ?? null,
    jobTitle: normalizeText(mapped.jobTitle) ?? null,
    seniorityLevel: coerceSeniority(mapped.seniorityLevel),
    department: normalizeText(mapped.department) ?? null,
    linkedinUrl: normalizeText(mapped.linkedinUrl) ?? null,
    linkedinPublicId: linkedinPublicId ?? null,
    salesNavProfileUrl: normalizeText(mapped.salesNavProfileUrl) ?? null,
    salesNavLeadId: salesNavLeadId ?? null,
    locationCountry: normalizeText(mapped.locationCountry) ?? null,
    locationCity: normalizeText(mapped.locationCity) ?? null,
  };
  if (storageEmail) {
    values.emailEnc = encryptPii(storageEmail);
    values.emailBlindIndex = blindIndex(normalizeEmailForIndex(storageEmail));
    values.emailDomain = emailDomainOf(storageEmail) ?? null;
  }
  const phone = normalizeText(mapped.phone);
  if (phone) values.phoneEnc = encryptPii(phone);

  return {
    values,
    dedupKeys: {
      emailBlindIndex: values.emailBlindIndex ?? undefined,
      linkedinPublicId: linkedinPublicId ?? undefined,
      salesNavLeadId: salesNavLeadId ?? undefined,
    },
    accountName: normalizeText(mapped.accountName),
    accountDomain: normalizeDomain(mapped.accountDomain),
  };
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

  let accountId: string | undefined;
  if (prepared.accountDomain) {
    accountId = await accountRepository.upsertByDomain(tx, {
      tenantId,
      workspaceId,
      name: prepared.accountName ?? prepared.accountDomain,
      domain: prepared.accountDomain,
    });
  }

  const values: ContactWriteValues = {
    ...prepared.values,
    tenantId,
    workspaceId,
    accountId: accountId ?? null,
  };
  // ALWAYS look up the match first — even for keep_both. The overlay enforces ONE contact per identity key
  // per workspace via the partial unique indexes (workspace_id, email_blind_index) /
  // (workspace_id, linkedin_public_id) / (workspace_id, sales_nav_lead_id) — 03 §5/§11. A blind insert on an
  // existing identity would just throw a unique-constraint violation, so we resolve the conflict in app code.
  const match = await contactRepository.findByDedupKeys(tx, workspaceId, prepared.dedupKeys);

  let contactId: string;
  let outcome: RowLandingOutcome;
  if (match) {
    // G-IMP-5 conflict policy (explicit, no longer silent last-writer-wins):
    //   - `skip`      → keep the existing contact untouched; count as a duplicate (no provenance row appended).
    //   - `keep_both` → a truly SEPARATE record can't exist in the overlay (one-per-identity-key), and
    //                   separate-record survivorship is ER's domain (30 §5, ADR-0021); until that lands,
    //                   keep_both holds the match back as a duplicate (NOT a silent overwrite) rather than
    //                   throwing a unique-constraint error on an insert that can never succeed.
    //   - `overwrite` → update the existing contact with the incoming values (the legacy last-writer-wins).
    if (policy === "skip" || policy === "keep_both") {
      // Held back as a duplicate (the contact already exists, untouched) — but still add it to the target list,
      // because the point of an "import into list" is membership. No new provenance row (the row didn't land).
      const addedToList = listId ? await addLandedToList(tx, input, listId, match.id, null) : false;
      return { outcome: "duplicate", contactId: match.id, sourceImportId: null, addedToList };
    }
    await contactRepository.update(tx, match.id, values);
    contactId = match.id;
    outcome = "matched";
  } else {
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

  const errors: ImportRowError[] = [];
  const rejectedRows: RejectedRow[] = [];
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
      errors.push({ row: i, message: verdict.reasons[0]?.reason ?? "Row rejected." });
      continue;
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
      // A DB/constraint failure after validation passed: surface it as a reject (it did not land).
      const message = err instanceof Error ? err.message : String(err);
      rejectedRows.push({ row: i, field: null, reason: message, raw });
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
  };
}
