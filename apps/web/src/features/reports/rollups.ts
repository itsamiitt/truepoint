// rollups.ts — pure aggregation for the Reports dashboards: counts in, per-dashboard view models out. No
// fetching, no React. Superseded by the ClickHouse pipeline post-MVP (ADR-0010 /reports/*).
//
// Each rollup exists in two forms and they share ONE implementation. The `*FromCounts` half turns counts into
// a view model — labels, conversion percentages, bar-width maxima, the fixed stage order — and is what the
// server-aggregated path (C-3.10) uses. The `rollup*` half counts a set of rows and delegates to it, which is
// the legacy client-side path over a 200-row sample.
//
// Sharing the implementation is the point: the presentation rules live once, so the two paths cannot drift
// into disagreeing about what a percentage means, and the existing unit tests for the row-based functions
// exercise the same code the server path runs through.

import type { EmailStatus, MaskedContact, OutreachStatus, RevealType } from "@leadwolf/types";
import {
  type CreditDay,
  type CreditRollup,
  type CreditTypeRow,
  type DataHealthRollup,
  EMAIL_STATUS_LABEL,
  EMAIL_STATUS_TONE,
  type FunnelRollup,
  type FunnelStage,
  OUTREACH_STATUS_LABEL,
  REVEAL_TYPE_LABEL,
  type TeamMemberRow,
  type TeamRollup,
  type UsageReveal,
} from "./types";

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 14;

const dayLabelFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** Local-date key (YYYY-MM-DD) so day buckets follow the viewer's timezone. */
function dayKey(d: Date): string {
  const month = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

const REVEAL_TYPES: RevealType[] = ["email", "phone", "full_profile"];

/** Bucket the usage rows into the last 14 local days, tally trailing-7-day totals + the per-reveal-type split. */
export function rollupCreditUsage(reveals: UsageReveal[], now = new Date()): CreditRollup {
  const days = new Map<string, CreditDay>();
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * DAY_MS);
    days.set(dayKey(d), { key: dayKey(d), label: dayLabelFmt.format(d), reveals: 0, credits: 0 });
  }

  const sevenDaysAgoMs = now.getTime() - 7 * DAY_MS;
  let revealsLast7 = 0;
  let creditsLast7 = 0;

  const typeReveals = new Map<RevealType, number>();
  const typeCredits = new Map<RevealType, number>();
  let totalCredits = 0;

  for (const r of reveals) {
    const at = new Date(r.revealedAt);
    if (Number.isNaN(at.getTime())) continue;
    if (at.getTime() >= sevenDaysAgoMs) {
      revealsLast7 += 1;
      creditsLast7 += r.creditsConsumed;
    }
    typeReveals.set(r.revealType, (typeReveals.get(r.revealType) ?? 0) + 1);
    typeCredits.set(r.revealType, (typeCredits.get(r.revealType) ?? 0) + r.creditsConsumed);
    totalCredits += r.creditsConsumed;
    const bucket = days.get(dayKey(at));
    if (bucket) {
      bucket.reveals += 1;
      bucket.credits += r.creditsConsumed;
    }
  }

  const byType: CreditTypeRow[] = REVEAL_TYPES.map((revealType) => ({
    revealType,
    label: REVEAL_TYPE_LABEL[revealType],
    reveals: typeReveals.get(revealType) ?? 0,
    credits: typeCredits.get(revealType) ?? 0,
  })).filter((row) => row.reveals > 0 || row.credits > 0);

  const list = [...days.values()];
  return {
    revealsLast7,
    creditsLast7,
    days: list,
    maxCredits: Math.max(...list.map((d) => d.credits), 1),
    byType,
    hasSpend: totalCredits > 0 || reveals.length > 0,
  };
}

/**
 * Build the credit view model from server-bucketed days + per-type totals (the shared core — see the header).
 *
 * The 14-day window is constructed here rather than taken from the server's rows: the chart needs a bucket
 * for every day INCLUDING the ones with no spend, and a server GROUP BY only returns days that have some. The
 * server's `day` keys are already in the viewer's zone (date_trunc with the IANA zone), so they line up with
 * the local keys generated below without any conversion.
 */
export function creditUsageFromBuckets(
  byDay: Array<{ day: string; reveals: number; credits: number }>,
  byTypeCounts: Array<{ revealType: RevealType; reveals: number; credits: number }>,
  now = new Date(),
): CreditRollup {
  const days = new Map<string, CreditDay>();
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * DAY_MS);
    days.set(dayKey(d), { key: dayKey(d), label: dayLabelFmt.format(d), reveals: 0, credits: 0 });
  }

  // Trailing 7 days by the same LOCAL day keys the buckets use, so the headline and the chart agree.
  const last7Keys = new Set<string>();
  for (let i = 0; i < 7; i++) last7Keys.add(dayKey(new Date(now.getTime() - i * DAY_MS)));

  let revealsLast7 = 0;
  let creditsLast7 = 0;
  for (const b of byDay) {
    const bucket = days.get(b.day);
    if (bucket) {
      bucket.reveals += b.reveals;
      bucket.credits += b.credits;
    }
    if (last7Keys.has(b.day)) {
      revealsLast7 += b.reveals;
      creditsLast7 += b.credits;
    }
  }

  const byType: CreditTypeRow[] = REVEAL_TYPES.map((revealType) => {
    const row = byTypeCounts.find((t) => t.revealType === revealType);
    return {
      revealType,
      label: REVEAL_TYPE_LABEL[revealType],
      reveals: row?.reveals ?? 0,
      credits: row?.credits ?? 0,
    };
  }).filter((row) => row.reveals > 0 || row.credits > 0);

  const list = [...days.values()];
  return {
    revealsLast7,
    creditsLast7,
    days: list,
    maxCredits: Math.max(...list.map((d) => d.credits), 1),
    byType,
    // Spend OUTSIDE the 14-day window still counts as "this workspace has spent" — the empty state is about
    // whether there is anything to show at all, not whether the chart happens to be populated.
    hasSpend: byTypeCounts.some((t) => t.reveals > 0 || t.credits > 0),
  };
}

const PRIMARY_STAGES: OutreachStatus[] = ["new", "in_sequence", "replied", "meeting_booked"];
const SECONDARY_STAGES: OutreachStatus[] = ["disqualified", "nurture", "unsubscribed"];

/** Build the funnel view model from per-status counts (the shared core — see the header). */
export function funnelFromCounts(counts: Map<OutreachStatus, number>, total: number): FunnelRollup {
  // Conversion is measured against the top of the journey (the "new" stage), so each row reads as
  // "of everyone who entered, this share reached here". Falls back to total contacts if "new" is empty.
  const top = counts.get("new") ?? 0;
  const base = top > 0 ? top : total;

  const toStage = (status: OutreachStatus, withConversion: boolean): FunnelStage => {
    const count = counts.get(status) ?? 0;
    return {
      status,
      label: OUTREACH_STATUS_LABEL[status],
      count,
      conversionPct: withConversion && base > 0 ? Math.round((count / base) * 100) : 0,
    };
  };

  const primary = PRIMARY_STAGES.map((s) => toStage(s, true));
  const secondary = SECONDARY_STAGES.map((s) => toStage(s, false));
  return {
    primary,
    secondary,
    total,
    maxCount: Math.max(...primary.map((s) => s.count), ...secondary.map((s) => s.count), 1),
  };
}

/** Count contacts per outreach status, then build the view model. The legacy sample-based path. */
export function rollupFunnel(contacts: MaskedContact[]): FunnelRollup {
  const counts = new Map<OutreachStatus, number>();
  for (const c of contacts) counts.set(c.outreachStatus, (counts.get(c.outreachStatus) ?? 0) + 1);
  return funnelFromCounts(counts, contacts.length);
}

const HEALTH_ORDER: EmailStatus[] = [
  "valid",
  "risky",
  "unverified",
  "invalid",
  "catch_all",
  "unknown",
];

/** Build the data-health view model from per-status counts (the shared core — see the header). */
export function dataHealthFromCounts(
  counts: Map<EmailStatus, number>,
  total: number,
  withEmail: number,
): DataHealthRollup {
  return {
    rows: HEALTH_ORDER.map((status) => {
      const count = counts.get(status) ?? 0;
      return {
        status,
        label: EMAIL_STATUS_LABEL[status],
        tone: EMAIL_STATUS_TONE[status],
        count,
        pct: total > 0 ? Math.round((count / total) * 100) : 0,
      };
    }),
    valid: counts.get("valid") ?? 0,
    withEmail,
    unverified: counts.get("unverified") ?? 0,
    total,
  };
}

/** Count contacts per email status, then build the view model. The legacy sample-based path. */
export function rollupDataHealth(contacts: MaskedContact[]): DataHealthRollup {
  const counts = new Map<EmailStatus, number>();
  let withEmail = 0;
  for (const c of contacts) {
    counts.set(c.emailStatus, (counts.get(c.emailStatus) ?? 0) + 1);
    if (c.hasEmail) withEmail += 1;
  }
  return dataHealthFromCounts(counts, contacts.length, withEmail);
}

/** A short, stable, PII-free member label from the owner id (no member directory in the MVP payload). */
function memberLabel(userId: string): string {
  const tail = userId.replace(/-/g, "").slice(-4).toUpperCase();
  return `Member ${tail || userId.slice(0, 4).toUpperCase()}`;
}

const ENGAGED_STATUSES = new Set<OutreachStatus>(["replied", "meeting_booked"]);

/** Build the team view model from per-member counts (the shared core — see the header). */
export function teamFromCounts(
  members: Array<{ userId: string; revealed: number; credits: number; engaged: number }>,
): TeamRollup {
  const list: TeamMemberRow[] = members
    .map((m) => ({ ...m, label: memberLabel(m.userId) }))
    .sort((a, b) => b.revealed - a.revealed);
  return {
    rows: list,
    members: list.length,
    totalRevealed: list.reduce((sum, r) => sum + r.revealed, 0),
  };
}

/** Per-member contribution from owned (revealed) contacts + their share of usage spend. Legacy path. */
export function rollupTeam(contacts: MaskedContact[], reveals: UsageReveal[]): TeamRollup {
  const rows = new Map<string, TeamMemberRow>();

  const ensure = (userId: string): TeamMemberRow => {
    let row = rows.get(userId);
    if (!row) {
      row = { userId, label: memberLabel(userId), revealed: 0, credits: 0, engaged: 0 };
      rows.set(userId, row);
    }
    return row;
  };

  for (const c of contacts) {
    if (!c.ownerUserId) continue;
    const row = ensure(c.ownerUserId);
    row.revealed += 1;
    if (ENGAGED_STATUSES.has(c.outreachStatus)) row.engaged += 1;
  }

  for (const r of reveals) {
    if (!r.revealedByUserId) continue;
    ensure(r.revealedByUserId).credits += r.creditsConsumed;
  }

  return teamFromCounts([...rows.values()]);
}
