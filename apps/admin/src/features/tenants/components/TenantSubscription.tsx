// TenantSubscription.tsx — the subscription panel on a tenant's detail (M11 subs, ADR-0041): the tenant's
// current recurring plan (status, term, renew/end date), sibling to the credit ledger. billing:read (the api
// enforces it too). Read-only mirror of Stripe state; null = month-to-month. Renders async state via the State Kit.
"use client";

import { useStaffMe } from "@/lib/staffMe";
import type { SubscriptionView } from "@leadwolf/types";
import { EmptyState, StateSwitch, StatusBadge, type StatusTone } from "@leadwolf/ui";
import { useCallback, useEffect, useState } from "react";
import { fetchTenantSubscription } from "../api";
import { shortDate } from "../format";

function statusTone(s: string): StatusTone {
  if (s === "active" || s === "trialing") return "success";
  if (s === "past_due" || s === "paused") return "warning";
  return "muted"; // canceled / incomplete
}

export function TenantSubscription({ tenantId }: { tenantId: string }) {
  const { canMaybe, loaded } = useStaffMe();
  const canView = canMaybe("billing:read");

  const [sub, setSub] = useState<SubscriptionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSub(await fetchTenantSubscription(tenantId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the subscription");
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    if (canView) void reload();
  }, [canView, reload]);

  // Hide the whole section once we know the caller can't view billing (the api also enforces it).
  if (loaded && !canView) return null;

  return (
    <div style={{ marginTop: 28 }}>
      <h3 className="tp-section-title">Subscription</h3>
      <StateSwitch
        loading={loading}
        error={error}
        empty={!loading && !error && !sub}
        onRetry={() => void reload()}
        emptyState={
          <EmptyState
            title="No subscription"
            description="This tenant is on no paid plan — Free/Community access only."
          />
        }
      >
        {sub ? (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "var(--tp-space-8)",
              alignItems: "baseline",
            }}
          >
            <div>
              <div className="app-muted" style={{ fontSize: "var(--tp-text-caption)" }}>
                Plan
              </div>
              <div>{sub.planName ?? sub.plan}</div>
            </div>
            <div>
              <div className="app-muted" style={{ fontSize: "var(--tp-text-caption)" }}>
                Status
              </div>
              <StatusBadge tone={statusTone(sub.status)}>
                {sub.status.replace(/_/g, " ")}
              </StatusBadge>
            </div>
            <div>
              <div className="app-muted" style={{ fontSize: "var(--tp-text-caption)" }}>
                Term
              </div>
              <div>{sub.term === "annual" ? "Annual" : "Monthly"}</div>
            </div>
            {sub.currentPeriodEnd ? (
              <div>
                <div className="app-muted" style={{ fontSize: "var(--tp-text-caption)" }}>
                  {sub.cancelAtPeriodEnd ? "Ends" : "Renews"}
                </div>
                <div className="tp-cell-mono">{shortDate(sub.currentPeriodEnd)}</div>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="app-muted" style={{ padding: "var(--tp-space-4)" }}>
            Month-to-month — no active subscription.
          </p>
        )}
      </StateSwitch>
    </div>
  );
}
