// types.ts — view models for the Sequences destination (11 §4.3, ADR-0009). The outreach API contract has
// no shared zod schemas yet, so the sequence/step/log shapes live here; contact types come from
// @leadwolf/types. Also holds the presentation maps (status → StatusBadge tone) and tiny format helpers.
//
// The redesign adds three surfaces behind a Tabs switch — Sequences (list + builder + enrollment), Templates
// (library + snippets + merge fields), and Send status (per-sequence send funnel) — plus an AI draft → review
// → send seam (/outreach/drafts). The Templates/Drafts backends are not built yet (M9), so those hooks surface
// a first-class EmptyState rather than inventing data; the GET /outreach/* sequence contracts are preserved.

import type { MaskedContact } from "@leadwolf/types";
import type { StatusTone } from "@leadwolf/ui";

// ── Outreach contract shapes (GET/POST /api/v1/outreach/*) ─────────────────────────────────────────────
export type SequenceStatus = "active" | "paused" | "archived";

/** Outreach channel for a step (05 §13). Email is automated at MVP; LinkedIn is human-in-the-loop (ToS). */
export type StepChannel = "email" | "linkedin";

/** Per-sequence send funnel (Send status dashboard). All aggregate counts — no PII. */
export interface SequenceMetrics {
  sent: number;
  opened: number;
  clicked: number;
  replied: number;
  bounced: number;
}

/** One row of GET /sequences — the list view's card/table shape. `metrics` is optional: older API
 *  responses omit it, in which case the list shows the counts it has and the send funnel reads as empty. */
export interface SequenceSummary {
  id: string;
  name: string;
  status: SequenceStatus;
  stepCount: number;
  enrolledCount: number;
  metrics?: SequenceMetrics;
}

/** POST /sequences body. The physical address is the CAN-SPAM footer line stamped on every send. */
export interface NewSequenceInput {
  name: string;
  from_address?: string;
  physical_address?: string;
}

/** POST /sequences/:id/steps body — email-only at MVP (ADR-0009); channel widens to linkedin post-MVP. */
export interface NewStepInput {
  channel?: StepChannel;
  delay_hours?: number;
  subject?: string;
  body: string;
  template_id?: string;
}

/** A step the builder has added this session (201 response + the local form values, for the recap list). */
export interface CreatedStep {
  id: string;
  stepOrder: number;
  channel: StepChannel;
  subject: string;
  delayHours: number;
}

export type EnrollmentStatus =
  | "enrolled"
  | "active"
  | "replied"
  | "completed"
  | "unsubscribed"
  | "bounced";

/** One row of GET /sequences/:id/log — a contact's journey through the sequence. */
export interface EnrollmentEntry {
  id: string;
  contactId: string;
  status: EnrollmentStatus;
  currentStep: number;
  lastEventAt: string;
}

/** 201 response of POST /sequences/:id/enroll. */
export interface EnrollResult {
  logId: string;
  status: string;
}

/** Response of POST /log/:id/send — the manual "Send next step" action. */
export interface SendResult {
  sent: true;
  step: number;
  messageId: string;
  status: string;
}

// ── Templates (GET /templates — M9, panel within Sequences; 11 §4.3, 05 §20) ───────────────────────────
/** One message template from the library: subject + body with {{merge_field}} placeholders. */
export interface TemplateSummary {
  id: string;
  name: string;
  channel: StepChannel;
  subject: string | null;
  body: string;
  updatedAt: string;
}

// ── Drafts (GET/POST/PATCH /outreach/drafts — AI draft → review → send seam; 05 §13/§16) ────────────────
export type DraftStatus = "drafting" | "review" | "approved" | "sent";

/** One AI/manual draft awaiting human review before it can be sent (augmented-human; 05 §16). */
export interface DraftSummary {
  id: string;
  contactId: string;
  sequenceId: string | null;
  status: DraftStatus;
  subject: string | null;
  body: string;
  updatedAt: string;
}

// ── Presentation maps (04 §1: color ONLY via StatusBadge tones) ────────────────────────────────────────
export const SEQUENCE_STATUS_TONE: Record<SequenceStatus, StatusTone> = {
  active: "success",
  paused: "warning",
  archived: "muted",
};

export const SEQUENCE_STATUS_LABEL: Record<SequenceStatus, string> = {
  active: "Active",
  paused: "Paused",
  archived: "Archived",
};

/** Enrollment status → badge tone; "neutral" renders as a plain grey pill (no status dot). */
export const ENROLLMENT_STATUS_TONE: Record<EnrollmentStatus, StatusTone | "neutral"> = {
  enrolled: "neutral",
  active: "neutral",
  replied: "success",
  completed: "muted",
  unsubscribed: "warning",
  bounced: "danger",
};

export const ENROLLMENT_STATUS_LABEL: Record<EnrollmentStatus, string> = {
  enrolled: "Enrolled",
  active: "Active",
  replied: "Replied",
  completed: "Completed",
  unsubscribed: "Unsubscribed",
  bounced: "Bounced",
};

/** Draft status → badge tone. "review" is the gate ("review required" before a send is ever offered). */
export const DRAFT_STATUS_TONE: Record<DraftStatus, StatusTone | "neutral"> = {
  drafting: "neutral",
  review: "warning",
  approved: "success",
  sent: "muted",
};

export const DRAFT_STATUS_LABEL: Record<DraftStatus, string> = {
  drafting: "Drafting",
  review: "Review required",
  approved: "Approved",
  sent: "Sent",
};

/** Channel → human label for step/template chips. */
export const CHANNEL_LABEL: Record<StepChannel, string> = {
  email: "Email",
  linkedin: "LinkedIn",
};

/** Terminal enrollment states — the journey is over, so the row gets no "Send next step" action. */
export const TERMINAL_ENROLLMENT_STATUSES: ReadonlySet<EnrollmentStatus> = new Set([
  "replied",
  "completed",
  "unsubscribed",
  "bounced",
]);

/** The merge fields the composer hints at — masked, PII-free facets that resolve at send time. */
export const MERGE_FIELDS: ReadonlyArray<{ token: string; description: string }> = [
  { token: "{{first_name}}", description: "Contact's first name" },
  { token: "{{last_name}}", description: "Contact's last name" },
  { token: "{{job_title}}", description: "Contact's job title" },
  { token: "{{company}}", description: "Contact's company" },
  { token: "{{sender_name}}", description: "Your name (sending identity)" },
];

// ── Tiny format helpers ────────────────────────────────────────────────────────────────────────────────
/** Short form of a UUID for dense tables (mirrors the billing usage table). */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

const eventDateFmt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatEventDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : eventDateFmt.format(d);
}

/** Empty send funnel — the zero-state metrics for a sequence the API didn't include counts for. */
export const EMPTY_METRICS: SequenceMetrics = {
  sent: 0,
  opened: 0,
  clicked: 0,
  replied: 0,
  bounced: 0,
};

/** A rate (0–1) of `part` over `whole`, guarding divide-by-zero; used for open/click/reply percentages. */
export function rate(part: number, whole: number): number {
  return whole <= 0 ? 0 : Math.max(0, Math.min(1, part / whole));
}

const pctFmt = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 0 });

/** Format a 0–1 rate as a whole-number percent ("42%"). */
export function formatPct(value: number): string {
  return pctFmt.format(value);
}

/** Label for the enroll picker: "First Last — Job title" (masked fields only; no PII). */
export function contactOptionLabel(c: MaskedContact): string {
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || "Unnamed contact";
  return c.jobTitle ? `${name} — ${c.jobTitle}` : name;
}
