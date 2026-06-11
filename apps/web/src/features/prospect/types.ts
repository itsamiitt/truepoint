// types.ts — view-model constants + presentation helpers for the prospect surface. Domain types come from
// @leadwolf/types (type-only, so zod never enters the browser bundle); this file holds presentation
// concerns: the email-status glyph mapping (kept monochrome except the tiny status mark — 04 §5) and the
// seniority picklist the filter rail renders.

import type { EmailStatus, MaskedContact, SeniorityLevel } from "@leadwolf/types";

/** A status glyph descriptor: the mark + its accessible label + a CSS modifier for the (rare) status color. */
export interface EmailGlyph {
  mark: string;
  label: string;
  /** "ok" → --tp-success, "warn" → --tp-warning, "none" → --tp-ink-4 (04 §5: color ONLY on the glyph). */
  tone: "ok" | "warn" | "none";
}

/**
 * Map an email status + presence to its tiny results-grid glyph (04 §5): ✓ valid, ? risky/unknown, — none.
 * Hierarchy stays in the glyph, never in row color, so the table reads monochrome.
 */
export function emailGlyphFor(c: MaskedContact): EmailGlyph {
  if (!c.hasEmail) return { mark: "—", label: "No email", tone: "none" };
  switch (c.emailStatus) {
    case "valid":
      return { mark: "✓", label: "Valid email", tone: "ok" };
    case "risky":
    case "catch_all":
      return { mark: "?", label: "Risky email", tone: "warn" };
    case "invalid":
      return { mark: "?", label: "Invalid email", tone: "warn" };
    default:
      return { mark: "?", label: "Unverified email", tone: "warn" };
  }
}

/** The masked email facet for the grid: the non-PII domain with a masked local part (05 §6). */
export function maskedEmail(c: MaskedContact): string {
  if (!c.hasEmail) return "—";
  return c.emailDomain ? `•••@${c.emailDomain}` : "••• (hidden)";
}

/** A contact's display name, falling back to an em dash when both parts are absent. */
export function displayName(c: MaskedContact): string {
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || "—";
}

/** Human label for the seniority enum (filter-rail dropdown + detail panel). */
export const SENIORITY_LABELS: Record<SeniorityLevel, string> = {
  c_suite: "C-suite",
  vp: "VP",
  director: "Director",
  manager: "Manager",
  ic: "Individual contributor",
  other: "Other",
};

export const SENIORITY_OPTIONS: { value: SeniorityLevel; label: string }[] = (
  ["c_suite", "vp", "director", "manager", "ic", "other"] as SeniorityLevel[]
).map((value) => ({ value, label: SENIORITY_LABELS[value] }));

/** Human label for a few email statuses surfaced in the detail panel. */
export const EMAIL_STATUS_LABELS: Record<EmailStatus, string> = {
  unverified: "Unverified",
  valid: "Valid",
  risky: "Risky",
  invalid: "Invalid",
  catch_all: "Catch-all",
  unknown: "Unknown",
};

/** The client-side filter the rail applies to the loaded rows (search is list-only at MVP — 05 §5). */
export interface ProspectFilter {
  query: string;
  seniority: SeniorityLevel | "";
  hasEmail: boolean;
}

export const EMPTY_FILTER: ProspectFilter = { query: "", seniority: "", hasEmail: false };

/** Apply the rail filter to the masked rows (title/name query · seniority · has-email). */
export function applyFilter(contacts: MaskedContact[], filter: ProspectFilter): MaskedContact[] {
  const q = filter.query.trim().toLowerCase();
  return contacts.filter((c) => {
    if (filter.hasEmail && !c.hasEmail) return false;
    if (filter.seniority && c.seniorityLevel !== filter.seniority) return false;
    if (q) {
      const haystack = [c.firstName, c.lastName, c.jobTitle, c.department, c.emailDomain]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}
