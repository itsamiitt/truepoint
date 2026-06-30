// staffWorkspaceExport.ts — the STAFF cross-tenant export EXECUTOR (database-management-research export; audit A1,
// Phase 2). Runs on approval of a `bulk_export` request, INSIDE the approve endpoint's withPlatformTx (owner) tx so
// it is atomic with the audited maker-checker decision. It reads the TARGET workspace's contacts
// (revealRepository.listForExport), applies the EXPLICIT-scope suppression filter (findMatchExplicit — the owner
// bypasses RLS, so the global/tenant/workspace scope is enforced explicitly), DECRYPTS only the survivors, and
// writes a CSV through the FileStore port.
//
// POLICY: platform-audited (the approval's platform_audit_log row), NOT per-contact credit-charged — this is an
// admin egress, not a customer reveal (so it does NOT route through revealContact's charge path). SECURITY-SENSITIVE:
// this is cross-tenant PII decryption; the suppression filter is the unbypassable gate and a suppressed subject is
// EXCLUDED before any ciphertext is decrypted. FLAGGED FOR SECURITY REVIEW (audit X3) — no gates run here.

import { type Tx, revealRepository, suppressionRepository } from "@leadwolf/db";
import { decryptPii } from "../import/encryptPii.ts";
import type { FileStore } from "../storage/fileStore.ts";

/** Hard cap on a single SYNCHRONOUS staff export (the executor runs in-request on approve). A larger target needs
 *  an async / chunked export — flagged (audit A1 follow-up). */
const STAFF_EXPORT_ROW_CAP = 50_000;

/** The exported columns — masked non-PII fields PLUS the decrypted email/phone. Stable order = deterministic file. */
const STAFF_EXPORT_COLUMNS = [
  "id",
  "firstName",
  "lastName",
  "jobTitle",
  "email",
  "phone",
  "emailStatus",
  "emailDomain",
  "seniorityLevel",
  "department",
  "locationCountry",
  "locationCity",
  "createdAt",
] as const;

/** Serialize rows to RFC-4180 CSV (always-quoted, CRLF) over the given columns. */
function toCsv(rows: Array<Record<string, unknown>>, columns: readonly string[]): string {
  const cell = (v: unknown): string => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const header = columns.map(cell).join(",");
  const lines = rows.map((r) => columns.map((c) => cell(r[c])).join(","));
  return [header, ...lines].join("\r\n");
}

export interface StaffWorkspaceExportInput {
  /** The TARGET tenant/workspace (from the approved bulk_export params). */
  tenantId: string;
  workspaceId: string;
  /** The injected object store (diskFileStore in dev; the prod S3 adapter at the app root). */
  fileStore: FileStore;
  /** The opaque FileStore key (e.g. `exports/staff/<approvalId>.csv`). */
  exportKey: string;
}

export interface StaffWorkspaceExportResult {
  key: string;
  /** Rows written (revealed, non-suppressed). */
  exported: number;
  /** Contacts excluded by the suppression gate. */
  suppressedExcluded: number;
  /** Contacts scanned (after the cap). */
  scanned: number;
  /** Whether the target exceeded the cap (the file is truncated — needs an async export). */
  capped: boolean;
}

/**
 * Execute a staff cross-tenant export within the caller's owner tx. See the file header for the policy + security
 * notes. Returns the artifact key + counts; the artifact is streamed by a separate data:export-gated route.
 */
export async function staffWorkspaceExport(
  tx: Tx,
  input: StaffWorkspaceExportInput,
): Promise<StaffWorkspaceExportResult> {
  // Read one over the cap to detect truncation.
  const contacts = await revealRepository.listForExport(
    tx,
    input.tenantId,
    input.workspaceId,
    STAFF_EXPORT_ROW_CAP + 1,
  );
  const capped = contacts.length > STAFF_EXPORT_ROW_CAP;
  const slice = capped ? contacts.slice(0, STAFF_EXPORT_ROW_CAP) : contacts;

  const rows: Array<Record<string, unknown>> = [];
  let suppressedExcluded = 0;
  for (const ct of slice) {
    // Unbypassable suppression gate (EXPLICIT-scope — the owner bypasses RLS). A hit EXCLUDES the subject; no
    // ciphertext is decrypted or surfaced for a suppressed contact.
    const hit = await suppressionRepository.findMatchExplicit(tx, {
      contactId: ct.id,
      emailBlindIndex: ct.emailBlindIndex,
      emailDomain: ct.emailDomain,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
    });
    if (hit) {
      suppressedExcluded++;
      continue;
    }
    rows.push({
      id: ct.id,
      firstName: ct.firstName,
      lastName: ct.lastName,
      jobTitle: ct.jobTitle,
      email: ct.emailEnc ? decryptPii(ct.emailEnc) : "",
      phone: ct.phoneEnc ? decryptPii(ct.phoneEnc) : "",
      emailStatus: ct.emailStatus,
      emailDomain: ct.emailDomain,
      seniorityLevel: ct.seniorityLevel,
      department: ct.department,
      locationCountry: ct.locationCountry,
      locationCity: ct.locationCity,
      createdAt: ct.createdAt,
    });
  }

  const csv = toCsv(rows, STAFF_EXPORT_COLUMNS);
  await input.fileStore.putArtifact(input.exportKey, new TextEncoder().encode(csv));
  return {
    key: input.exportKey,
    exported: rows.length,
    suppressedExcluded,
    scanned: slice.length,
    capped,
  };
}
