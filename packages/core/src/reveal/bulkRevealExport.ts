// bulkRevealExport.ts — customer own-workspace REVEALED CSV export (database-management-research 12 §export;
// 16-Implementation-Audit A1, Phase 1). Exports a workspace's selected contacts WITH decrypted email/phone, by
// revealing each one THROUGH the gated revealContact path — so every row is suppression-checked, charged, and
// audited exactly like a single reveal (NEVER a raw SELECT of *_enc + decryptPii). A suppressed contact throws
// inside revealContact and is EXCLUDED from the file (the unbypassable suppression gate: a suppressed subject can
// never reach the export). The CSV is written through the FileStore PORT (dev disk now; prod S3 injected at the
// app composition root) — core stays free of any cloud SDK.
//
// SCOPE: this is the CUSTOMER own-workspace path — every reveal runs in revealContact's own withTenantTx, so the
// suppression check is RLS-correct. The STAFF cross-tenant export (privileged role, where the RLS-backed
// suppression matcher does not hold) is a SEPARATE path that needs an explicit-scope matcher + security review.
//
// PERF NOTE (follow-up): one withTenantTx per contact (revealContact is self-contained). Fine for a bounded
// selection; a large export should share one tx via an extracted reveal core (see the audit). Bounded by the
// caller's selection cap.

import { type TenantScope, contactRepository, withTenantTx } from "@leadwolf/db";
import { ForbiddenError, SuppressedError, type WorkspaceRole } from "@leadwolf/types";
import type { FileStore } from "../storage/fileStore.ts";
import { revealContact } from "./revealContact.ts";

type WorkspaceScope = TenantScope & { workspaceId: string };

/** Roles allowed to export — mirrors bulkActions.EXPORT_ROLES (viewer is denied). */
const EXPORT_ROLES: ReadonlySet<WorkspaceRole> = new Set(["owner", "admin", "member"]);

/** The REVEALED export columns — the masked non-PII fields PLUS the decrypted email/phone (the PII egress).
 *  Distinct from bulkActions.EXPORT_COLUMNS (which never includes plaintext). Stable order = deterministic file. */
const REVEALED_EXPORT_COLUMNS = [
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

export interface BulkRevealExportInput {
  scope: WorkspaceScope;
  callerUserId: string;
  role: WorkspaceRole;
  /** The explicit selection (already the user's own workspace; filtered to visible + live here). */
  contactIds: string[];
  /** The injected object store (diskFileStore in dev; the prod S3 adapter at the app root). */
  fileStore: FileStore;
  /** The opaque FileStore key to write the CSV to (caller-generated, e.g. `exports/<ws>/<id>.csv`). */
  exportKey: string;
}

export interface BulkRevealExportResult {
  key: string;
  downloadUrl: string;
  /** Rows written to the CSV (revealed, non-suppressed). */
  exported: number;
  /** Contacts skipped because they were suppressed (excluded from the file). */
  suppressedExcluded: number;
  /** Visible contacts considered (after the cross-workspace + live filter). */
  selected: number;
}

/**
 * Export the visible selection as a REVEALED CSV. Role-gated (viewer → 403). Each contact is revealed through
 * `revealContact` (full_profile) so it is suppression-gated, charged, and audited per row; a `SuppressedError`
 * excludes that contact from the file. The masked non-PII fields are joined from `listMaskedByIds`. The result
 * CSV is written through the `FileStore` and a download URL is returned.
 *
 * Spend: the caller MUST show + confirm `estimateBulkSpend` (worst case) before calling this — each newly-revealed
 * contact charges credits; already-revealed ones are free (first-wins). An `InsufficientCreditsError` from a
 * reveal propagates (the export aborts) — estimate first.
 */
export async function bulkRevealExport(input: BulkRevealExportInput): Promise<BulkRevealExportResult> {
  if (!EXPORT_ROLES.has(input.role)) {
    throw new ForbiddenError("insufficient_role", "Your role does not allow exporting contacts.");
  }

  // 1) Resolve the visible + live subset and read the masked (non-PII) columns, in one workspace-scoped tx.
  const masked = await withTenantTx(input.scope, async (tx) => {
    const ids = await contactRepository.visibleContactIds(tx, input.contactIds);
    return contactRepository.listMaskedByIds(tx, ids);
  });

  // 2) Reveal each visible contact through the gate. A suppressed contact throws → EXCLUDE it from the export
  //    (the suppression invariant). Other errors (e.g. insufficient credits) propagate and abort the export.
  const revealedById = new Map<string, { email: string | null; phone: string | null; emailStatus: string }>();
  let suppressedExcluded = 0;
  for (const m of masked as Array<{ id: string }>) {
    try {
      const r = await revealContact({
        scope: input.scope,
        userId: input.callerUserId,
        contactId: m.id,
        revealType: "full_profile",
      });
      revealedById.set(m.id, { email: r.email, phone: r.phone, emailStatus: r.emailStatus });
    } catch (err) {
      if (err instanceof SuppressedError) {
        suppressedExcluded++;
        continue;
      }
      throw err;
    }
  }

  // 3) Build the CSV rows — only the contacts that revealed (suppressed ones are absent entirely, masked fields
  //    included), merging the decrypted email/phone onto the masked row.
  const rows = (masked as Array<Record<string, unknown> & { id: string }>)
    .filter((m) => revealedById.has(m.id))
    .map((m) => {
      const rev = revealedById.get(m.id);
      return { ...m, email: rev?.email ?? "", phone: rev?.phone ?? "", emailStatus: rev?.emailStatus };
    });
  const csv = toCsv(rows, REVEALED_EXPORT_COLUMNS);

  // 4) Write through the FileStore port + hand back a download URL (signed + expiring in prod; file:// in dev).
  await input.fileStore.putArtifact(input.exportKey, new TextEncoder().encode(csv));
  const downloadUrl = await input.fileStore.getSignedDownloadUrl(input.exportKey);

  return {
    key: input.exportKey,
    downloadUrl,
    exported: rows.length,
    suppressedExcluded,
    selected: masked.length,
  };
}
