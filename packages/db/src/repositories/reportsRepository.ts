// reportsRepository.ts — the server-side report aggregates (C-3.10).
//
// These replace rollups the browser computed over the most recent 200 contacts and 200 reveals, which made
// every number wrong above that. Counting is all that moves: labels, conversion percentages and bar maxima
// stay client-side in the existing pure rollups.
//
// Every query runs inside ONE withTenantTx, so RLS supplies the tenant + workspace predicate and none of the
// SQL below carries a workspace filter of its own — the same discipline as every other repository here. One
// transaction rather than one per aggregate, because they are rendered together: counts read across separate
// transactions could disagree with each other if a reveal lands mid-render.
//
// Day bucketing takes the viewer's IANA zone through `date_trunc(field, source, timezone)` (PG16). That is
// what makes this a faithful replacement rather than a behaviour change: the charts have always used the
// viewer's local day, and a UTC-only aggregate would have shifted every one of them for non-UTC users.
import { and, eq, gte, sql } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { contactReveals } from "../schema/billing.ts";
import { contacts } from "../schema/contacts.ts";

export interface ReportsSummaryFilters {
  /** Lower bound on contact `created_at` / reveal `revealed_at`; null means all time. */
  since: Date | null;
  /** A member user id, or null for every member. */
  memberId: string | null;
  /** IANA zone for day bucketing. Validated at the contract boundary before it reaches SQL. */
  tz: string;
}

/** Counts only — the shapes the client's pure rollups consume. */
export interface ReportsSummaryRows {
  contactTotal: number;
  withEmail: number;
  funnel: Array<{ status: string; count: number }>;
  health: Array<{ status: string; count: number }>;
  creditsByDay: Array<{ day: string; reveals: number; credits: number }>;
  creditsByType: Array<{ revealType: string; reveals: number; credits: number }>;
  team: Array<{ userId: string; revealed: number; credits: number; engaged: number }>;
  memberOptions: string[];
}

const num = (v: unknown): number => Number(v ?? 0);

/** Postgres returns bigint counts as strings and `execute` as loose rows; normalise both in one place. */
function rows<T extends Record<string, unknown>>(result: unknown): T[] {
  return result as unknown as T[];
}

export const reportsRepository = {
  /** Every rollup for one filter combination, in a single scoped transaction. */
  async summary(scope: TenantScope, filters: ReportsSummaryFilters): Promise<ReportsSummaryRows> {
    return withTenantTx(scope, async (tx: Tx) => {
      const since = filters.since;
      const memberId = filters.memberId;

      // ── contacts: total, funnel, health and coverage in ONE grouped pass ──────────────────────────────
      const contactRows = await tx
        .select({
          outreachStatus: contacts.outreachStatus,
          emailStatus: contacts.emailStatus,
          // The coverage numerator. `email_enc` is the encrypted PII column — this only asks whether one is
          // PRESENT, never decrypts it, so the aggregate stays as PII-free as the masked rows it replaces.
          hasEmail: sql<number>`count(*) FILTER (WHERE ${contacts.emailEnc} IS NOT NULL)`,
          total: sql<number>`count(*)`,
        })
        .from(contacts)
        .where(
          and(
            since ? gte(contacts.createdAt, since) : undefined,
            memberId ? eq(contacts.ownerUserId, memberId) : undefined,
          ),
        )
        .groupBy(contacts.outreachStatus, contacts.emailStatus);

      let contactTotal = 0;
      let withEmail = 0;
      const funnelMap = new Map<string, number>();
      const healthMap = new Map<string, number>();
      for (const r of contactRows) {
        const n = num(r.total);
        contactTotal += n;
        withEmail += num(r.hasEmail);
        funnelMap.set(r.outreachStatus, (funnelMap.get(r.outreachStatus) ?? 0) + n);
        healthMap.set(r.emailStatus, (healthMap.get(r.emailStatus) ?? 0) + n);
      }

      const revealWhere = and(
        since ? gte(contactReveals.revealedAt, since) : undefined,
        memberId ? eq(contactReveals.revealedByUserId, memberId) : undefined,
      );

      // ── reveals per LOCAL day (the viewer's zone) and per reveal type ─────────────────────────────────
      const dayRows = await tx
        .select({
          // `AT TIME ZONE` after the truncation is load-bearing. date_trunc(..., tz) returns a TIMESTAMPTZ —
          // the instant of local midnight — and to_char would then format it in the SESSION zone (UTC),
          // labelling IST's 11th as the 10th. Converting to a local timestamp first makes the label the
          // viewer's actual calendar day.
          day: sql<string>`to_char(date_trunc('day', ${contactReveals.revealedAt}, ${filters.tz}) AT TIME ZONE ${filters.tz}, 'YYYY-MM-DD')`,
          reveals: sql<number>`count(*)`,
          credits: sql<number>`coalesce(sum(${contactReveals.creditsConsumed}), 0)`,
        })
        .from(contactReveals)
        .where(revealWhere)
        .groupBy(sql`1`)
        .orderBy(sql`1`);

      const typeRows = await tx
        .select({
          revealType: contactReveals.revealType,
          reveals: sql<number>`count(*)`,
          credits: sql<number>`coalesce(sum(${contactReveals.creditsConsumed}), 0)`,
        })
        .from(contactReveals)
        .where(revealWhere)
        .groupBy(contactReveals.revealType);

      // ── team: owned contacts joined to spend, keyed by user ───────────────────────────────────────────
      // FULL OUTER JOIN because the two sides are different populations: a member can own contacts without
      // having spent (assigned or inherited rows) and can have spent on contacts they do not own. An inner
      // join would silently drop whichever member sits on only one side — which is most of them.
      // ISO string + an explicit cast, not the Date itself. Drizzle's typed builders know a column's type and
      // serialise a Date for it; the raw `sql` path has no such context, so postgres.js receives a Date where
      // it expects a string and throws ERR_INVALID_ARG_TYPE at bind time. Only the FILTERED queries hit it,
      // which is why it survived until an itest exercised a date range.
      const sinceIso = since?.toISOString() ?? null;
      const sinceContacts = sinceIso ? sql`AND created_at >= ${sinceIso}::timestamptz` : sql``;
      const sinceReveals = sinceIso ? sql`AND revealed_at >= ${sinceIso}::timestamptz` : sql``;
      const ownerFilter = memberId ? sql`AND owner_user_id = ${memberId}` : sql``;
      const revealerFilter = memberId ? sql`AND revealed_by_user_id = ${memberId}` : sql``;

      const teamResult = await tx.execute(sql`
        WITH owned AS (
          SELECT owner_user_id AS user_id,
                 count(*) AS revealed,
                 count(*) FILTER (WHERE outreach_status IN ('replied','meeting_booked')) AS engaged
            FROM contacts
           WHERE owner_user_id IS NOT NULL ${sinceContacts} ${ownerFilter}
           GROUP BY 1
        ),
        spent AS (
          SELECT revealed_by_user_id AS user_id,
                 coalesce(sum(credits_consumed), 0) AS credits
            FROM contact_reveals
           WHERE true ${sinceReveals} ${revealerFilter}
           GROUP BY 1
        )
        SELECT coalesce(o.user_id, s.user_id) AS user_id,
               coalesce(o.revealed, 0)        AS revealed,
               coalesce(s.credits, 0)         AS credits,
               coalesce(o.engaged, 0)         AS engaged
          FROM owned o
          FULL OUTER JOIN spent s ON s.user_id = o.user_id
         ORDER BY 2 DESC
      `);

      // ── member options ────────────────────────────────────────────────────────────────────────────────
      // Deliberately NOT filtered by `memberId`: the dropdown has to keep offering the other members while
      // one is selected, or choosing a member would strand the filter on that member permanently.
      const memberResult = await tx.execute(sql`
        SELECT DISTINCT user_id FROM (
          SELECT owner_user_id AS user_id FROM contacts
           WHERE owner_user_id IS NOT NULL ${sinceContacts}
          UNION
          SELECT revealed_by_user_id AS user_id FROM contact_reveals
           WHERE true ${sinceReveals}
        ) m
        ORDER BY 1
      `);

      return {
        contactTotal,
        withEmail,
        funnel: [...funnelMap].map(([status, count]) => ({ status, count })),
        health: [...healthMap].map(([status, count]) => ({ status, count })),
        creditsByDay: dayRows.map((r) => ({
          day: String(r.day),
          reveals: num(r.reveals),
          credits: num(r.credits),
        })),
        creditsByType: typeRows.map((r) => ({
          revealType: r.revealType,
          reveals: num(r.reveals),
          credits: num(r.credits),
        })),
        team: rows<{ user_id: string; revealed: number; credits: number; engaged: number }>(
          teamResult,
        ).map((r) => ({
          userId: String(r.user_id),
          revealed: num(r.revealed),
          credits: num(r.credits),
          engaged: num(r.engaged),
        })),
        memberOptions: rows<{ user_id: string }>(memberResult).map((r) => String(r.user_id)),
      };
    });
  },
};
