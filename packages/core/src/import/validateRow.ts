// validateRow.ts — pure, DB-free per-row validation for the pre-commit preview AND the runImport reject
// collection (30 §4, ADR-0036 §7; closes the G-IMP-1 validation half). It maps + normalizes a raw row and
// decides whether it COULD land: a row is rejected if it carries no identity key (email / LinkedIn /
// Sales-Nav id) or a malformed mapped value (e.g. a non-email "email"). It does NOT encrypt or hit the DB —
// that stays in runImport; this is the shared verdict both the preview and the import use so they never
// disagree. Returns a structured verdict with per-field reasons (the rejected-rows artifact rows).

import type { ColumnMapping, RejectedRow } from "@leadwolf/types";
import { type MappedRow, type RawRow, mapRow } from "./columnMap.ts";
import {
  linkedinPublicIdOf,
  normalizeEmailForIndex,
  normalizeEmailForStorage,
  normalizeText,
} from "./normalize.ts";

/** The dedup identity key derived from a valid row — used to estimate within-file duplicates (preview §5.1). */
export interface RowIdentity {
  emailKey?: string;
  linkedinPublicId?: string;
  salesNavLeadId?: string;
}

export type RowVerdict =
  | { ok: true; mapped: MappedRow; identity: RowIdentity }
  | { ok: false; reasons: { field: string | null; reason: string }[] };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate one raw row against `mapping`. Pure: same input → same verdict, no IO. A row is rejected when it
 * has no identity key, or a mapped value is malformed. Each reason names its offending `field` (or null for a
 * whole-row reason) so the rejected-rows file can point the user at the exact fix.
 */
export function validateRow(raw: RawRow, mapping: ColumnMapping): RowVerdict {
  const mapped = mapRow(raw, mapping);
  const reasons: { field: string | null; reason: string }[] = [];

  // Field-level format checks (only for fields actually mapped + present).
  const storageEmail = normalizeEmailForStorage(mapped.email);
  if (mapped.email != null && !storageEmail && !EMAIL_RE.test(mapped.email.trim())) {
    reasons.push({ field: "email", reason: "Malformed email address." });
  } else if (storageEmail && !EMAIL_RE.test(storageEmail)) {
    reasons.push({ field: "email", reason: "Malformed email address." });
  }

  const linkedinPublicId = linkedinPublicIdOf(mapped.linkedinPublicId ?? mapped.linkedinUrl);
  const salesNavLeadId = normalizeText(mapped.salesNavLeadId);

  // The hard requirement (mirrors runImport.prepareContact): at least one identity key.
  const validEmailKey = storageEmail && EMAIL_RE.test(storageEmail) ? storageEmail : undefined;
  if (!validEmailKey && !linkedinPublicId && !salesNavLeadId) {
    reasons.push({
      field: null,
      reason: "Row has no email, LinkedIn, or Sales Navigator identifier.",
    });
  }

  if (reasons.length > 0) return { ok: false, reasons };

  const identity: RowIdentity = {};
  if (validEmailKey) identity.emailKey = normalizeEmailForIndex(validEmailKey);
  if (linkedinPublicId) identity.linkedinPublicId = linkedinPublicId;
  if (salesNavLeadId) identity.salesNavLeadId = salesNavLeadId;
  return { ok: true, mapped, identity };
}

/** Build the rejected-rows artifact entries for a verdict's reasons (one entry per offending field). */
export function rejectedRowsFor(
  row: number,
  raw: RawRow,
  reasons: { field: string | null; reason: string }[],
): RejectedRow[] {
  return reasons.map((r) => ({ row, field: r.field, reason: r.reason, raw }));
}

/**
 * A STABLE, NON-PII label for a row rejection, keyed by the offending field + the KIND of failure (never a row
 * value) — the histogram bucket both the sync (runImport) and bulk (bulkStage) import paths tally (G08). A
 * free-text catch-path message (which may embed a value) is deliberately collapsed to "Processing error", so no
 * value is ever surfaced. Shared so the customer and staff breakdowns show identical labels.
 */
export function rejectLabel(field: string | null, kind: "validation" | "rule" | "error"): string {
  if (kind === "error") return "Processing error";
  const f = field ?? "row";
  if (kind === "rule") return `${f}: failed a rule`;
  return field ? `${field}: invalid value` : "Missing identifier";
}

/** A stable signature for a row's identity (within-file dedup key). Undefined when the row has no key. */
export function identitySignature(identity: RowIdentity): string | undefined {
  if (identity.emailKey) return `e:${identity.emailKey}`;
  if (identity.linkedinPublicId) return `l:${identity.linkedinPublicId}`;
  if (identity.salesNavLeadId) return `s:${identity.salesNavLeadId}`;
  return undefined;
}
