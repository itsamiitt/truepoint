// runImport.ts — the load-bearing per-workspace import pipeline (05 §3, ADR-0006). For each parsed row:
// map → normalize → derive blind index + content hash → encrypt PII → (in ONE withTenantTx) idempotency
// check → upsert account by domain → dedup-match the contact (email → linkedin → sales-nav) → insert or
// update → append exactly one source_imports provenance row. Returns the new-vs-matched-vs-skipped tally.
// Each row runs in its own tight transaction so one bad row never rolls back the whole import.

import {
  type ContactWriteValues,
  type DedupKeys,
  type Tx,
  accountRepository,
  contactRepository,
  sourceImportRepository,
  withTenantTx,
} from "@leadwolf/db";
import type {
  ColumnMapping,
  ConflictPolicy,
  ImportRowError,
  ImportRowOutcome,
  ImportSummary,
  RejectedRow,
  SourceName,
} from "@leadwolf/types";
import { DEFAULT_CONFLICT_POLICY } from "@leadwolf/types";
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

async function importOneRow(
  tx: Tx,
  input: RunImportInput,
  raw: RawRow,
  prepared: PreparedContact,
  hash: Uint8Array,
  policy: ConflictPolicy,
): Promise<RowLandingOutcome> {
  const { tenantId, workspaceId } = input.scope;

  // Identical payload already imported into this workspace → no-op (idempotent re-import).
  if (await sourceImportRepository.findByContentHash(tx, workspaceId, hash)) return "skipped";

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
    if (policy === "skip" || policy === "keep_both") return "duplicate";
    await contactRepository.update(tx, match.id, values);
    contactId = match.id;
    outcome = "matched";
  } else {
    contactId = await contactRepository.insert(tx, values);
    outcome = "created";
  }

  await sourceImportRepository.append(tx, {
    tenantId,
    workspaceId,
    contactId,
    importedByUserId: input.importedByUserId ?? null,
    sourceName: input.sourceName,
    sourceFile: input.sourceFile ?? null,
    rawData: raw,
    contentHash: hash,
  });
  return outcome;
}

/**
 * Run a full per-workspace import and return the three-way accounting summary (30 §4): created / matched /
 * skipped / duplicates / rejected, plus the rejected-rows artifact. A row that fails validation is REJECTED
 * (collected with per-field reasons for the downloadable error file, G-IMP-1) — it never reaches the DB; a
 * row that matches under a `skip` conflict policy is a DUPLICATE (held back); everything else lands.
 */
export async function runImport(input: RunImportInput): Promise<ImportSummary> {
  const policy: ConflictPolicy = input.conflictPolicy ?? DEFAULT_CONFLICT_POLICY;
  const errors: ImportRowError[] = [];
  const rejectedRows: RejectedRow[] = [];
  let created = 0;
  let matched = 0;
  let skipped = 0;
  let duplicates = 0;

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
      const outcome = await withTenantTx(input.scope, (tx) =>
        importOneRow(tx, input, raw, prepared, hash, policy),
      );
      if (outcome === "created") created++;
      else if (outcome === "matched") matched++;
      else if (outcome === "duplicate") duplicates++;
      else skipped++;
    } catch (err) {
      // A DB/constraint failure after validation passed: surface it as a reject (it did not land).
      const message = err instanceof Error ? err.message : String(err);
      rejectedRows.push({ row: i, field: null, reason: message, raw });
      errors.push({ row: i, message });
    }
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
    errors,
    rejectedRows,
  };
}
