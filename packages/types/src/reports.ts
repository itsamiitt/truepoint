// reports.ts — the server-aggregated report summary (C-3.10).
//
// The dashboards used to roll up in the browser over the most recent 200 contacts and 200 reveals, which made
// every number wrong above that and labelled it as a total. This contract moves the COUNTING to the database.
//
// It deliberately carries counts, not view models. Labels, conversion percentages and bar-width maxima are
// presentation — they are derived on the client by the existing pure rollups, which are already unit-tested
// and have no reason to move. What could not be computed correctly from a sample was the counting, and that
// is all the server does here.
//
// `tz` is what makes this a faithful replacement rather than a behaviour change. Day buckets have always
// followed the VIEWER's local day, and Postgres reproduces that exactly — `date_trunc('day', ts, $tz)` takes
// an IANA zone — so the client sends its own zone and the charts do not shift for anyone.
import { z } from "zod";
import { revealType } from "./billing.ts";
import { emailStatus, outreachStatus } from "./contacts.ts";

/** Trailing windows the filter row offers. `all` means "no lower bound". */
export const reportRange = z.enum(["7d", "14d", "30d", "all"]);
export type ReportRange = z.infer<typeof reportRange>;

export const reportsSummaryQuerySchema = z.object({
  range: reportRange.default("14d"),
  /** A member's user id, or `all`. Filters every rollup below, so the page's two filters compose. */
  member: z.string().default("all"),
  /**
   * IANA zone for day bucketing (e.g. "Asia/Kolkata"). Bounded and pattern-checked because it reaches
   * `date_trunc`'s third argument: an unknown zone makes Postgres raise, and an unbounded string has no
   * business being interpolated anywhere near SQL. The server falls back to UTC when it is absent.
   */
  tz: z
    .string()
    .max(64)
    .regex(/^[A-Za-z0-9_+\-/]+$/)
    .default("UTC"),
});
export type ReportsSummaryQuery = z.infer<typeof reportsSummaryQuerySchema>;

/** One outreach stage's contact count. The journey/off-ramp split and the conversion maths stay client-side. */
export const funnelBucketSchema = z.object({
  status: outreachStatus,
  count: z.number().int().nonnegative(),
});

/** One local day's spend. `day` is a YYYY-MM-DD key already bucketed in the requested zone. */
export const creditDayBucketSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reveals: z.number().int().nonnegative(),
  credits: z.number().int().nonnegative(),
});

export const creditTypeBucketSchema = z.object({
  revealType,
  reveals: z.number().int().nonnegative(),
  credits: z.number().int().nonnegative(),
});

/** Per-member activity — the GROUP BY owner the client could never do from a page of rows. */
export const teamBucketSchema = z.object({
  userId: z.string().uuid(),
  revealed: z.number().int().nonnegative(),
  credits: z.number().int().nonnegative(),
  engaged: z.number().int().nonnegative(),
});

export const healthBucketSchema = z.object({
  status: emailStatus,
  count: z.number().int().nonnegative(),
});

/** The member filter's options, from the whole workspace rather than whichever rows happened to load.
 *  Ids ONLY: the client already synthesises the display label from the id, and returning names here would
 *  quietly turn a report into a new place user identities are exposed. */
export const reportMemberOptionSchema = z.string().uuid();

export const reportsSummarySchema = z.object({
  /** Total contacts matching the filters — the denominator every share is computed against. */
  contactTotal: z.number().int().nonnegative(),
  funnel: z.array(funnelBucketSchema),
  creditsByDay: z.array(creditDayBucketSchema),
  creditsByType: z.array(creditTypeBucketSchema),
  team: z.array(teamBucketSchema),
  health: z.array(healthBucketSchema),
  /** Contacts with any email on file — the coverage numerator, not derivable from the status buckets. */
  withEmail: z.number().int().nonnegative(),
  memberOptions: z.array(reportMemberOptionSchema),
});
export type ReportsSummary = z.infer<typeof reportsSummarySchema>;
