// types.ts — view models for the Sequences destination (11 §4.3, ADR-0009). The outreach API contract has
// no shared zod schemas yet, so the sequence/step/log shapes live here; contact types come from
// @leadwolf/types. Also holds the presentation maps (status → StatusBadge tone) and tiny format helpers.

import type { MaskedContact } from "@leadwolf/types";
import type { StatusTone } from "@leadwolf/ui";

// ── Outreach contract shapes (GET/POST /api/v1/outreach/*) ─────────────────────────────────────────────
export type SequenceStatus = "active" | "paused" | "archived";

/** One row of GET /sequences — the list view's card/table shape. */
export interface SequenceSummary {
  id: string;
  name: string;
  status: SequenceStatus;
  stepCount: number;
  enrolledCount: number;
}

/** POST /sequences body. The physical address is the CAN-SPAM footer line stamped on every send. */
export interface NewSequenceInput {
  name: string;
  from_address?: string;
  physical_address?: string;
}

/** POST /sequences/:id/steps body — email-only at MVP (ADR-0009). */
export interface NewStepInput {
  channel?: "email";
  delay_hours?: number;
  subject?: string;
  body: string;
}

/** A step the builder has added this session (201 response + the local form values, for the recap list). */
export interface CreatedStep {
  id: string;
  stepOrder: number;
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

/** Terminal enrollment states — the journey is over, so the row gets no "Send next step" action. */
export const TERMINAL_ENROLLMENT_STATUSES: ReadonlySet<EnrollmentStatus> = new Set([
  "replied",
  "completed",
  "unsubscribed",
  "bounced",
]);

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

/** Label for the enroll picker: "First Last — Job title" (masked fields only; no PII). */
export function contactOptionLabel(c: MaskedContact): string {
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || "Unnamed contact";
  return c.jobTitle ? `${name} — ${c.jobTitle}` : name;
}
