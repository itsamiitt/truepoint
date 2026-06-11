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
  ImportRowError,
  ImportRowOutcome,
  ImportSummary,
  SourceName,
} from "@leadwolf/types";
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

const SENIORITY = new Set(["c_suite", "vp", "director", "manager", "ic", "other"]);

export interface RunImportInput {
  scope: { tenantId: string; workspaceId: string };
  importedByUserId?: string;
  sourceName: SourceName;
  sourceFile?: string;
  mapping: ColumnMapping;
  rows: RawRow[]; // already parsed (parseImportFile)
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

async function importOneRow(
  tx: Tx,
  input: RunImportInput,
  raw: RawRow,
  prepared: PreparedContact,
  hash: Uint8Array,
): Promise<ImportRowOutcome> {
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
  const match = await contactRepository.findByDedupKeys(tx, workspaceId, prepared.dedupKeys);

  let contactId: string;
  let outcome: ImportRowOutcome;
  if (match) {
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

/** Run a full per-workspace import and return the new-vs-matched-vs-skipped summary. */
export async function runImport(input: RunImportInput): Promise<ImportSummary> {
  const errors: ImportRowError[] = [];
  let created = 0;
  let matched = 0;
  let skipped = 0;

  for (let i = 0; i < input.rows.length; i++) {
    const raw = input.rows[i]!;
    try {
      const mapped = mapRow(raw, input.mapping);
      const prepared = prepareContact(mapped);
      const hash = contentHash({ mapped, sourceName: input.sourceName });
      const outcome = await withTenantTx(input.scope, (tx) =>
        importOneRow(tx, input, raw, prepared, hash),
      );
      if (outcome === "created") created++;
      else if (outcome === "matched") matched++;
      else skipped++;
    } catch (err) {
      errors.push({ row: i, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return { total: input.rows.length, created, matched, skipped, errors };
}
