// types.ts — view-model constants + presentation helpers for the prospect surface. Domain types come from
// @leadwolf/types (type-only, so zod never enters the browser bundle); this file holds presentation concerns:
// the email-status glyph mapping (kept monochrome except the tiny status mark — 04 §5), the human labels for
// the enums the rail and the drawers render, and the status→tone maps. (The MVP client-side filter model
// that used to live here was dead since the server-search rewrite and was removed on 2026-08-25; the live
// model is filterGroups.ts.)

import type { EmailStatus, MaskedContact, OutreachStatus, SeniorityLevel } from "@leadwolf/types";
import type { ProspectRow } from "./databaseRows";

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

/**
 * The glyph for a Search row. A NOT-SAVED row (a database person) carries no verification state of its own —
 * the platform only says an email is on file — so it gets a neutral "on file" mark rather than the amber
 * "Unverified" that reads as a warning about data nobody has looked at yet (decisions.md 2026-08-25).
 */
export function emailGlyphForRow(row: ProspectRow): EmailGlyph {
  if (row.databaseSlug !== undefined && row.hasEmail) {
    return { mark: "•", label: "Email on file — reveal to verify", tone: "none" };
  }
  return emailGlyphFor(row);
}

/** The masked email facet for the grid: the non-PII domain with a masked local part (05 §6). */
export function maskedEmail(c: MaskedContact): string {
  if (!c.hasEmail) return "—";
  return c.emailDomain ? `•••@${c.emailDomain}` : "••• (hidden)";
}

/** A contact's display name — name parts, else the LinkedIn slug (a name-less capture row must still be
 *  identifiable, D4), else an em dash. */
export function displayName(c: MaskedContact): string {
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ");
  if (name) return name;
  if (c.linkedinPublicId) return `linkedin.com/in/${c.linkedinPublicId}`;
  return "—";
}

/** The best public profile link for a contact (public URL, else Sales-Nav lead URL), or null. */
export function profileHref(c: MaskedContact): string | null {
  return c.linkedinUrl ?? c.salesNavProfileUrl ?? null;
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

export type StatusTone = "success" | "warning" | "danger" | "muted";

/** Color-coded StatusBadge tone for a revealed email verification status (green valid / amber risky-etc /
 *  red invalid / muted). Takes a raw status string (the revealed view carries it as a string). */
export function emailStatusTone(status: string | null): StatusTone {
  switch (status) {
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

/** Human label for a raw email status string (falls back to the raw value for anything unmapped). */
export function emailStatusLabel(status: string | null): string {
  if (!status) return "—";
  return EMAIL_STATUS_LABELS[status as EmailStatus] ?? status;
}

/** Color-coded StatusBadge tone for a revealed phone verification status. */
export function phoneStatusTone(status: string | null): StatusTone {
  switch (status) {
    case "valid":
    case "mobile":
    case "direct":
    case "hq":
      return "success";
    case "invalid":
      return "danger";
    default:
      return "muted";
  }
}

/** Human label for a phone carrier line type (Twilio line_type_intelligence). */
export const PHONE_LINE_TYPE_LABELS: Record<string, string> = {
  mobile: "Mobile",
  landline: "Landline",
  voip: "VoIP",
  direct: "Direct dial",
  hq: "HQ line",
  unknown: "Unknown line",
};

/** Human label for a phone line type string, falling back to a title-cased raw value. */
export function phoneLineTypeLabel(lineType: string | null): string | null {
  if (!lineType) return null;
  return PHONE_LINE_TYPE_LABELS[lineType] ?? lineType;
}
