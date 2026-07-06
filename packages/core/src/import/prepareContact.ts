// prepareContact.ts — the ONE canonical row-preparation step (normalize + encrypt + blind-index + derive dedup
// keys) shared by the synchronous import (runImport.ts) AND the bulk COPY-staging path (bulkStage, phase 5).
// Extracted VERBATIM from runImport.ts so both paths normalize/encrypt/dedup IDENTICALLY — the bulk-vs-sync
// parity guarantee (15-bulk-import-design §1). Pure: no DB, no I/O.

import type { ContactWriteValues, DedupKeys } from "@leadwolf/db";
import { blindIndex } from "./blindIndex.ts";
import type { MappedRow } from "./columnMap.ts";
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

export type PreparedValues = Omit<ContactWriteValues, "tenantId" | "workspaceId" | "accountId">;

export interface PreparedContact {
  values: PreparedValues;
  dedupKeys: DedupKeys;
  accountName?: string;
  accountDomain?: string;
  /** The cleaned as-entered phone PLAINTEXT (the exact string `values.phoneEnc` encrypts) — carried for the
   *  S-CH2 channel dual-write, whose child row needs the raw-digits blind index + E.164 derivation
   *  (05 §4; the doc-sanctioned prepareContact EXTENSION, never a fork). Absent when the row has no phone.
   *  In-memory only: never staged, never logged (bulkStage.toStagingRow picks fields explicitly). */
  phoneRaw?: string;
}

export function coerceSeniority(raw: string | undefined): string | null {
  const v = normalizeText(raw)
    ?.toLowerCase()
    .replace(/[\s-]+/g, "_");
  return v && SENIORITY.has(v) ? v : null;
}

/** Pure preparation: normalize + encrypt + derive keys. Throws if the row carries no identity key. */
export function prepareContact(mapped: MappedRow): PreparedContact {
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
    phoneRaw: phone,
  };
}
