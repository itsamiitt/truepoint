// SubscriptionTab.tsx — the billing hub's Subscription tab (M11 subs, ADR-0041): the tenant's current
// subscription (plan, status, renew/end date), or the month-to-month default when there's none. Read-only
// mirror of Stripe state; owns its own data so it's independent of the Plan/Credits load. Replaces the former
// placeholder. Cancel/manage controls arrive with the Stripe billing portal (Phase 3).
"use client";

import type { SubscriptionView } from "@leadwolf/types";
import { Card, StateSwitch, StatusBadge, type StatusTone } from "@leadwolf/ui";
import { useCallback, useEffect, useState } from "react";
import { fetchSubscription } from "../../api";
import styles from "../../billing.module.css";

function statusTone(s: string): StatusTone {
  if (s === "active" || s === "trialing") return "success";
  if (s === "past_due" || s === "paused") return "warning";
  return "muted"; // canceled / incomplete
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function SubscriptionTab() {
  const [sub, setSub] = useState<SubscriptionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSub(await fetchSubscription());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load subscription");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <StateSwitch loading={loading} error={error} onRetry={reload}>
      {sub ? (
        <Card style={{ padding: 24 }}>
          <div className={styles.cardHead}>
            <span className={styles.cardLabel}>{sub.planName ?? sub.plan}</span>
            <StatusBadge tone={statusTone(sub.status)}>{sub.status.replace(/_/g, " ")}</StatusBadge>
          </div>
          <div style={{ display: "flex", gap: 40, margin: "16px 0" }}>
            <div>
              <div className="app-muted" style={{ fontSize: 12 }}>
                Billing
              </div>
              <div>{sub.term === "annual" ? "Annual" : "Monthly"}</div>
            </div>
            {sub.currentPeriodEnd && (
              <div>
                <div className="app-muted" style={{ fontSize: 12 }}>
                  {sub.cancelAtPeriodEnd ? "Ends" : "Renews"}
                </div>
                <div>{fmtDate(sub.currentPeriodEnd)}</div>
              </div>
            )}
          </div>
          <p className="app-muted" style={{ fontSize: 13, marginBottom: 0 }}>
            {sub.cancelAtPeriodEnd
              ? "Your subscription is set to end at the close of the current period. Purchased credits never expire."
              : sub.status === "past_due"
                ? "We couldn't process your last payment. Update your payment method to keep your plan active."
                : "Your monthly credit allotment refreshes each period; unused allotment doesn't carry over. Purchased credits never expire."}
          </p>
        </Card>
      ) : (
        <Card style={{ padding: 24 }}>
          <div className={styles.cardHead}>
            <span className={styles.cardLabel}>Month-to-month</span>
          </div>
          <p className="app-muted" style={{ fontSize: 13, marginBottom: 0 }}>
            You're on month-to-month — no auto-renewal, no lock-in, and your credits never expire.
            Choose a plan on the Plan tab to subscribe for a recurring monthly credit allotment.
          </p>
        </Card>
      )}
    </StateSwitch>
  );
}
