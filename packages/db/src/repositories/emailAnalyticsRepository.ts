// emailAnalyticsRepository.ts — deliverability/engagement aggregation (M12 P5, 08, 15 §A.3). Reads the
// email_event tracking store (+ the email_replied activity) and returns workspace-scoped (RLS) counts over a
// trailing window. P5 ships the on-read aggregate; the partitioned hour/day ROLLUP tables (15 §A.3) are the
// scale step once volume warrants — the shape here is the rollup's source. Reply is the primary KPI (D6).

import { sql } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";

export interface EmailMetricCounts {
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
  replied: number;
}

const ZERO: EmailMetricCounts = {
  delivered: 0,
  opened: 0,
  clicked: 0,
  bounced: 0,
  complained: 0,
  unsubscribed: 0,
  replied: 0,
};

const EVENT_TO_KEY: Record<string, keyof EmailMetricCounts> = {
  delivery: "delivered",
  open: "opened",
  click: "clicked",
  bounce: "bounced",
  complaint: "complained",
  unsubscribe: "unsubscribed",
};

export const emailAnalyticsRepository = {
  /** Trailing-window event counts for the workspace (RLS-scoped). `replied` comes from the activity stream. */
  async workspaceMetrics(scope: TenantScope, sinceDays = 30): Promise<EmailMetricCounts> {
    return withTenantTx(scope, async (tx: Tx) => {
      const since = new Date(Date.now() - sinceDays * 86_400_000);
      const eventRows = (await tx.execute(
        sql`SELECT event_type, count(*)::int AS n FROM email_event
            WHERE occurred_at >= ${since} GROUP BY event_type`,
      )) as unknown as Array<{ event_type: string; n: number }>;
      const out: EmailMetricCounts = { ...ZERO };
      for (const r of eventRows) {
        const key = EVENT_TO_KEY[r.event_type];
        if (key) out[key] = Number(r.n);
      }
      const replied = (await tx.execute(
        sql`SELECT count(*)::int AS n FROM activities
            WHERE activity_type = 'email_replied' AND occurred_at >= ${since}`,
      )) as unknown as Array<{ n: number }>;
      out.replied = Number(replied[0]?.n ?? 0);
      return out;
    });
  },
};
