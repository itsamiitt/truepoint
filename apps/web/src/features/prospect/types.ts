// types.ts — view-model constants + presentation helpers for the prospect surface. Domain types come from
// @leadwolf/types (type-only, so zod never enters the browser bundle); this file holds presentation concerns:
// the email-status glyph mapping (kept monochrome except the tiny status mark — 04 §5), the faceted filter
// model the rail renders + applies client-side (search is list-only at MVP — 05 §5), and the active-filter
// summary the rail surfaces above the grid.

import type {
  EmailStatus,
  MaskedContact,
  OutreachStatus,
  SeniorityLevel,
} from "@leadwolf/types";

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

/** Human label for the seniority enum (filter-rail facets + detail panel). */
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

/** Human label for the email-status enum (filter facets + detail panel). */
export const EMAIL_STATUS_LABELS: Record<EmailStatus, string> = {
  unverified: "Unverified",
  valid: "Valid",
  risky: "Risky",
  invalid: "Invalid",
  catch_all: "Catch-all",
  unknown: "Unknown",
};

export const EMAIL_STATUS_OPTIONS: { value: EmailStatus; label: string }[] = (
  ["valid", "risky", "catch_all", "invalid", "unverified", "unknown"] as EmailStatus[]
).map((value) => ({ value, label: EMAIL_STATUS_LABELS[value] }));

/** Human label for the outreach-status enum (filter facets + detail panel). */
export const OUTREACH_STATUS_LABELS: Record<OutreachStatus, string> = {
  new: "New",
  in_sequence: "In sequence",
  replied: "Replied",
  meeting_booked: "Meeting booked",
  disqualified: "Disqualified",
  nurture: "Nurture",
  unsubscribed: "Unsubscribed",
};

export const OUTREACH_STATUS_OPTIONS: { value: OutreachStatus; label: string }[] = (
  [
    "new",
    "in_sequence",
    "replied",
    "meeting_booked",
    "disqualified",
    "nurture",
    "unsubscribed",
  ] as OutreachStatus[]
).map((value) => ({ value, label: OUTREACH_STATUS_LABELS[value] }));

/** The map between the two grid scopes shown by the Contacts⇄Accounts segmented control. */
export type ResultScope = "contacts" | "accounts";

/**
 * The faceted, client-side filter the rail applies to the loaded rows (search is list-only at MVP — 05 §5).
 * Multi-select facets are arrays; ranges are nullable numbers (empty input = no bound). Score ranges are a
 * placeholder until the masked list carries a non-PII priority score; they're wired but no-op until then.
 */
export interface ProspectFilter {
  query: string;
  seniority: SeniorityLevel[];
  emailStatus: EmailStatus[];
  outreachStatus: OutreachStatus[];
  /** Searchable single-value facets (Combobox over the loaded rows' distinct values). */
  department: string | null;
  country: string | null;
  hasEmail: boolean;
  hasPhone: boolean;
}

export const EMPTY_FILTER: ProspectFilter = {
  query: "",
  seniority: [],
  emailStatus: [],
  outreachStatus: [],
  department: null,
  country: null,
  hasEmail: false,
  hasPhone: false,
};

/** True when no facet is set — used to hide the active-filter summary + disable Clear all. */
export function isEmptyFilter(f: ProspectFilter): boolean {
  return (
    f.query.trim() === "" &&
    f.seniority.length === 0 &&
    f.emailStatus.length === 0 &&
    f.outreachStatus.length === 0 &&
    f.department === null &&
    f.country === null &&
    !f.hasEmail &&
    !f.hasPhone
  );
}

/** Toggle one value in a multi-select facet array (add if absent, remove if present). */
export function toggleFacet<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

/** One active-filter chip surfaced in the summary row: a label + a removal that clears just that facet. */
export interface ActiveFilterChip {
  key: string;
  label: string;
  clear: (f: ProspectFilter) => ProspectFilter;
}

/** Derive the active-filter chip list for the summary row (one chip per set facet value). */
export function activeFilterChips(f: ProspectFilter): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = [];
  if (f.query.trim()) {
    chips.push({
      key: "query",
      label: `“${f.query.trim()}”`,
      clear: (s) => ({ ...s, query: "" }),
    });
  }
  for (const s of f.seniority) {
    chips.push({
      key: `seniority:${s}`,
      label: SENIORITY_LABELS[s],
      clear: (cur) => ({ ...cur, seniority: cur.seniority.filter((v) => v !== s) }),
    });
  }
  for (const s of f.emailStatus) {
    chips.push({
      key: `email:${s}`,
      label: `Email: ${EMAIL_STATUS_LABELS[s]}`,
      clear: (cur) => ({ ...cur, emailStatus: cur.emailStatus.filter((v) => v !== s) }),
    });
  }
  for (const s of f.outreachStatus) {
    chips.push({
      key: `outreach:${s}`,
      label: OUTREACH_STATUS_LABELS[s],
      clear: (cur) => ({ ...cur, outreachStatus: cur.outreachStatus.filter((v) => v !== s) }),
    });
  }
  if (f.department) {
    chips.push({
      key: "department",
      label: f.department,
      clear: (s) => ({ ...s, department: null }),
    });
  }
  if (f.country) {
    chips.push({ key: "country", label: f.country, clear: (s) => ({ ...s, country: null }) });
  }
  if (f.hasEmail) {
    chips.push({ key: "hasEmail", label: "Has email", clear: (s) => ({ ...s, hasEmail: false }) });
  }
  if (f.hasPhone) {
    chips.push({ key: "hasPhone", label: "Has phone", clear: (s) => ({ ...s, hasPhone: false }) });
  }
  return chips;
}

/** Apply the faceted rail filter to the masked rows (query · seniority · email-status · outreach · etc.). */
export function applyFilter(contacts: MaskedContact[], filter: ProspectFilter): MaskedContact[] {
  const q = filter.query.trim().toLowerCase();
  return contacts.filter((c) => {
    if (filter.hasEmail && !c.hasEmail) return false;
    if (filter.hasPhone && !c.hasPhone) return false;
    if (filter.seniority.length > 0) {
      if (!c.seniorityLevel || !filter.seniority.includes(c.seniorityLevel)) return false;
    }
    if (filter.emailStatus.length > 0 && !filter.emailStatus.includes(c.emailStatus)) return false;
    if (filter.outreachStatus.length > 0 && !filter.outreachStatus.includes(c.outreachStatus)) {
      return false;
    }
    if (filter.department && c.department !== filter.department) return false;
    if (filter.country && c.locationCountry !== filter.country) return false;
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

/** Distinct, sorted non-null values of one masked-contact field — drives the searchable facet Comboboxes. */
export function distinctValues(
  contacts: MaskedContact[],
  pick: (c: MaskedContact) => string | null,
): string[] {
  const set = new Set<string>();
  for (const c of contacts) {
    const v = pick(c);
    if (v) set.add(v);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Human label for an activity type (timeline rows). */
export const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  email_sent: "Email sent",
  email_opened: "Email opened",
  email_clicked: "Link clicked",
  email_replied: "Replied",
  call_made: "Call made",
  call_connected: "Call connected",
  linkedin_message: "LinkedIn message",
  linkedin_connected: "LinkedIn connected",
  sales_nav_inmail: "InMail",
  meeting_held: "Meeting held",
  note_added: "Note",
};

/** The Data-Health tone for a contact's email status (the detail panel's StatusBadge). */
export function dataHealthTone(c: MaskedContact): "success" | "warning" | "danger" | "muted" {
  if (!c.hasEmail) return "muted";
  switch (c.emailStatus) {
    case "valid":
      return "success";
    case "invalid":
      return "danger";
    case "risky":
    case "catch_all":
    case "unverified":
    case "unknown":
      return "warning";
    default:
      return "muted";
  }
}
