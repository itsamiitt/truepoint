// rollups.ts — pure client-side aggregation for the Reports MVP: raw credits-usage rows + masked contacts
// in, per-section view models out. No fetching, no React. Everything here is superseded by the ClickHouse
// pipeline post-MVP (ADR-0010).

import type { EmailStatus, MaskedContact, OutreachStatus } from "@leadwolf/types";
import {
  type CreditDay,
  type CreditRollup,
  type DataHealthRollup,
  EMAIL_STATUS_LABEL,
  EMAIL_STATUS_TONE,
  type FunnelRollup,
  type FunnelStage,
  OUTREACH_STATUS_LABEL,
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

/** Bucket the usage rows into the last 14 local days + tally the trailing-7-day reveal/credit totals. */
export function rollupCreditUsage(reveals: UsageReveal[], now = new Date()): CreditRollup {
  const days = new Map<string, CreditDay>();
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * DAY_MS);
    days.set(dayKey(d), { key: dayKey(d), label: dayLabelFmt.format(d), reveals: 0, credits: 0 });
  }

  const sevenDaysAgoMs = now.getTime() - 7 * DAY_MS;
  let revealsLast7 = 0;
  let creditsLast7 = 0;

  for (const r of reveals) {
    const at = new Date(r.revealedAt);
    if (Number.isNaN(at.getTime())) continue;
    if (at.getTime() >= sevenDaysAgoMs) {
      revealsLast7 += 1;
      creditsLast7 += r.creditsConsumed;
    }
    const bucket = days.get(dayKey(at));
    if (bucket) {
      bucket.reveals += 1;
      bucket.credits += r.creditsConsumed;
    }
  }

  const list = [...days.values()];
  return {
    revealsLast7,
    creditsLast7,
    days: list,
    maxCredits: Math.max(...list.map((d) => d.credits), 1),
  };
}

const PRIMARY_STAGES: OutreachStatus[] = ["new", "in_sequence", "replied", "meeting_booked"];
const SECONDARY_STAGES: OutreachStatus[] = ["disqualified", "nurture", "unsubscribed"];

/** Count contacts per outreach status, split into the journey stages and the muted off-ramps. */
export function rollupFunnel(contacts: MaskedContact[]): FunnelRollup {
  const counts = new Map<OutreachStatus, number>();
  for (const c of contacts) counts.set(c.outreachStatus, (counts.get(c.outreachStatus) ?? 0) + 1);

  const toStage = (status: OutreachStatus): FunnelStage => ({
    status,
    label: OUTREACH_STATUS_LABEL[status],
    count: counts.get(status) ?? 0,
  });

  const primary = PRIMARY_STAGES.map(toStage);
  const secondary = SECONDARY_STAGES.map(toStage);
  return {
    primary,
    secondary,
    total: contacts.length,
    maxCount: Math.max(...primary.map((s) => s.count), ...secondary.map((s) => s.count), 1),
  };
}

const HEALTH_ORDER: EmailStatus[] = [
  "valid",
  "risky",
  "unverified",
  "invalid",
  "catch_all",
  "unknown",
];

/** Count contacts per email verification status + the email-coverage numerator. */
export function rollupDataHealth(contacts: MaskedContact[]): DataHealthRollup {
  const counts = new Map<EmailStatus, number>();
  let withEmail = 0;
  for (const c of contacts) {
    counts.set(c.emailStatus, (counts.get(c.emailStatus) ?? 0) + 1);
    if (c.hasEmail) withEmail += 1;
  }
  return {
    rows: HEALTH_ORDER.map((status) => ({
      status,
      label: EMAIL_STATUS_LABEL[status],
      tone: EMAIL_STATUS_TONE[status],
      count: counts.get(status) ?? 0,
    })),
    withEmail,
    total: contacts.length,
  };
}
