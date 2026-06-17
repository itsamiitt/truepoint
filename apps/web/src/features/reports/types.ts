// types.ts — view models for the Reports destination (11 §4.5 MVP slice). The real analytics pipeline
// (ClickHouse /reports/*, ADR-0010) is post-MVP, so the dashboards that CAN be computed today are client-side
// rollups over the credits + contacts endpoints; the rest render a first-class "connect …" empty state.
// Color stays confined to StatusBadge / Progress tones (04 §1).

// UsageReveal carries revealedByUserId — the Reports "member" dimension. Re-exported (per the slice convention)
// so the slice's api/hooks/components share one shape with apps/api's /credits/usage payload (07 §9, 09 §3).
import type {
  EmailStatus,
  OutreachStatus,
  RevealType,
  UsageReveal as TUsageReveal,
} from "@leadwolf/types";
import type { StatusTone } from "@leadwolf/ui";

export type UsageReveal = TUsageReveal;

/** The dashboards in the Tabs switcher, in display order. */
export type DashboardId = "funnel" | "credits" | "deliverability" | "team" | "health" | "score";

/** One day's bucket in the 14-day credit-usage bar list / table. */
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
  /** Spend split by reveal type — the credit-usage table rows. */
  byType: CreditTypeRow[];
  /** Whether any spend exists at all (drives the empty state). */
  hasSpend: boolean;
}

export interface CreditTypeRow {
  revealType: RevealType;
  label: string;
  reveals: number;
  credits: number;
}

export interface FunnelStage {
  status: OutreachStatus;
  label: string;
  count: number;
  /** Conversion vs. the first primary stage (0–100), for the journey rows only. */
  conversionPct: number;
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
  /** Share of all contacts (0–100). */
  pct: number;
}

export interface DataHealthRollup {
  rows: HealthRow[];
  /** Contacts whose email verified `valid` — the deliverable-rate numerator. */
  valid: number;
  /** Contacts with any email on file — the coverage line's numerator. */
  withEmail: number;
  /** Contacts marked unverified — the staleness line's numerator. */
  unverified: number;
  total: number;
}

/** One member's contribution row in the Team activity table (keyed by the masked ownerUserId). */
export interface TeamMemberRow {
  userId: string;
  /** A short, stable, PII-free label derived from the id (no member directory in the MVP payload). */
  label: string;
  /** Contacts this member owns (revealed). */
  revealed: number;
  /** Credits this member spent across the loaded usage window. */
  credits: number;
  /** Owned contacts that reached replied/meeting_booked. */
  engaged: number;
}

export interface TeamRollup {
  rows: TeamMemberRow[];
  members: number;
  totalRevealed: number;
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

export const REVEAL_TYPE_LABEL: Record<RevealType, string> = {
  email: "Email",
  phone: "Phone",
  full_profile: "Full profile",
};
