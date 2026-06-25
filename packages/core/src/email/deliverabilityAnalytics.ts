// deliverabilityAnalytics.ts — the deliverability + engagement report (M12 P5, 08; email-planning/13 P5).
// Aggregates the workspace's email_event/activity counts into the rates the /reports dashboard shows. Per D6,
// REPLY RATE is the primary KPI and opens are informational (MPP-inflated); both are returned, the UI
// de-emphasises opens. Owner-scoped analytics (a rep sees own) is a refinement on top of this workspace-level
// aggregate. Rates are percentages to one decimal; a zero denominator yields 0 (never NaN).

import { type EmailMetricCounts, type TenantScope, emailAnalyticsRepository } from "@leadwolf/db";

export interface DeliverabilityReport extends EmailMetricCounts {
  /** Attempted sends ≈ delivered + bounced (a send resolves to one or the other). */
  sent: number;
  deliveryRate: number;
  openRate: number; // informational (D6)
  clickRate: number;
  replyRate: number; // PRIMARY KPI (D6)
  bounceRate: number;
  complaintRate: number;
  rangeDays: number;
}

function pct(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
}

export async function computeDeliverability(
  scope: TenantScope,
  rangeDays = 30,
): Promise<DeliverabilityReport> {
  const c = await emailAnalyticsRepository.workspaceMetrics(scope, rangeDays);
  const sent = c.delivered + c.bounced;
  return {
    ...c,
    sent,
    deliveryRate: pct(c.delivered, sent),
    openRate: pct(c.opened, c.delivered),
    clickRate: pct(c.clicked, c.delivered),
    replyRate: pct(c.replied, c.delivered),
    bounceRate: pct(c.bounced, sent),
    complaintRate: pct(c.complained, c.delivered),
    rangeDays,
  };
}
