// TenantEconomics.tsx — the per-tenant economics drill-down on a tenant's detail (13a Area 4, 07 §9): the
// windowed + lifetime money picture (revenue, provider spend, margin, cost-per-reveal, credits sold/consumed,
// balance, last top-up) over a selectable window. Visible only to billing:read (the api enforces it too); the
// numbers are realized spend — packs-not-subscriptions, so there is NO MRR/ARR (OD-1 decision-gated). Renders
// async state through the State Kit.
"use client";

import { useStaffMe } from "@/lib/staffMe";
import type { TenantEconomicsDetail } from "@leadwolf/types";
import { StatTile, StateSwitch, TpSelect } from "@leadwolf/ui";
import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { fetchTenantEconomics } from "../api";
import { shortDate } from "../format";

function money(cents: number): string {
  return (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" });
}

const PERIODS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "365 days" },
];

const GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
  gap: 12,
};

export function TenantEconomics({ tenantId }: { tenantId: string }) {
  const { canMaybe, loaded } = useStaffMe();
  const canView = canMaybe("billing:read");

  const [sinceDays, setSinceDays] = useState(30);
  const [data, setData] = useState<TenantEconomicsDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchTenantEconomics(tenantId, sinceDays));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load economics");
    } finally {
      setLoading(false);
    }
  }, [tenantId, sinceDays]);

  useEffect(() => {
    if (canView) void reload();
  }, [canView, reload]);

  // Hide the whole section once we know the caller can't view billing (the api also enforces it).
  if (loaded && !canView) return null;

  return (
    <div style={{ marginTop: 28 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <h3 className="tp-section-title" style={{ margin: 0 }}>
          Economics
        </h3>
        <TpSelect
          aria-label="Economics window"
          value={String(sinceDays)}
          onChange={(e) => setSinceDays(Number(e.target.value))}
        >
          {PERIODS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </TpSelect>
      </div>

      <StateSwitch loading={loading} error={error} onRetry={() => void reload()}>
        {data ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={GRID}>
              <StatTile
                label={`Revenue · ${sinceDays}d`}
                value={money(data.revenueCents)}
                sublabel={`${data.creditsSold.toLocaleString()} credits sold`}
              />
              <StatTile
                label="Provider spend"
                value={money(data.providerSpendCents)}
                sublabel={`margin ${money(data.marginCents)}`}
              />
              <StatTile
                label="Cost / reveal"
                value={money(data.costPerRevealCents)}
                sublabel={`${data.chargedReveals.toLocaleString()} charged of ${data.reveals.toLocaleString()}`}
              />
              <StatTile
                label="Credits consumed"
                value={data.creditsConsumed.toLocaleString()}
                sublabel={`balance ${data.revealCreditBalance.toLocaleString()}`}
              />
            </div>
            <div style={GRID}>
              <StatTile
                label="Lifetime revenue"
                value={money(data.lifetimeRevenueCents)}
                sublabel={`${data.lifetimeCreditsSold.toLocaleString()} credits sold`}
              />
              <StatTile
                label="Lifetime consumed"
                value={data.lifetimeCreditsConsumed.toLocaleString()}
                sublabel="all-time reveal spend"
              />
              <StatTile
                label="Refunded (lifetime)"
                value={money(data.lifetimeRefundedCents)}
                sublabel={`${money(data.refundedCents)} in window`}
              />
              <StatTile
                label="Last top-up"
                value={data.lastPurchaseAt ? shortDate(data.lastPurchaseAt) : "—"}
                sublabel={`plan ${data.plan}`}
              />
            </div>
          </div>
        ) : null}
      </StateSwitch>
    </div>
  );
}
