// types.ts — view models for the Reports destination (11 §4.5 MVP slice). The real analytics pipeline
// (ClickHouse, ADR-0010) is post-MVP, so these shapes are client-side rollups over the credits + contacts
// endpoints. Presentation maps live here too — color stays confined to StatusBadge tones (04 §1).

import type { EmailStatus, OutreachStatus, RevealType } from "@leadwolf/types";
import type { StatusTone } from "@leadwolf/ui";

/** One metered reveal from GET /credits/usage — the raw row the credit rollup consumes. */
export interface UsageReveal {
  id: string;
  contactId: string;
  revealType: RevealType;
  creditsConsumed: number;
  revealedAt: string;
}

/** One day's bucket in the 14-day credit-usage bar list. */
export interface CreditDay {
  /** Local-date key (YYYY-MM-DD) so buckets follow the viewer's timezone. */
  key: string;
  /** Short display label, e.g. "Jun 3". */
  label: string;
  reveals: number;
  credits: number;
}

export interface CreditRollup {
  revealsLast7: number;
  creditsLast7: number;
  /** Exactly 14 buckets, oldest → newest (today last). */
  days: CreditDay[];
  /** Largest per-day credit spend (≥ 1 so bar widths never divide by zero). */
  maxCredits: number;
}

export interface FunnelStage {
  status: OutreachStatus;
  label: string;
  count: number;
}

export interface FunnelRollup {
  /** The journey: new → in_sequence → replied → meeting_booked. */
  primary: FunnelStage[];
  /** The off-ramps, rendered muted: disqualified · nurture · unsubscribed. */
  secondary: FunnelStage[];
  total: number;
  /** Largest stage count across both rows (≥ 1 so bar widths never divide by zero). */
  maxCount: number;
}

export interface HealthRow {
  status: EmailStatus;
  label: string;
  tone: StatusTone;
  count: number;
}

export interface DataHealthRollup {
  rows: HealthRow[];
  /** Contacts with any email on file — the coverage line's numerator. */
  withEmail: number;
  total: number;
}

export const OUTREACH_STATUS_LABEL: Record<OutreachStatus, string> = {
  new: "New",
  in_sequence: "In sequence",
  replied: "Replied",
  meeting_booked: "Meeting booked",
  disqualified: "Disqualified",
  nurture: "Nurture",
  unsubscribed: "Unsubscribed",
};

export const EMAIL_STATUS_LABEL: Record<EmailStatus, string> = {
  valid: "Valid",
  risky: "Risky",
  unverified: "Unverified",
  invalid: "Invalid",
  catch_all: "Catch-all",
  unknown: "Unknown",
};

/** Verification status → badge tone (mirrors the prospect glyphs: valid ok, risky/catch-all warn). */
export const EMAIL_STATUS_TONE: Record<EmailStatus, StatusTone> = {
  valid: "success",
  risky: "warning",
  unverified: "muted",
  invalid: "danger",
  catch_all: "warning",
  unknown: "muted",
};
