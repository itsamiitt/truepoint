// TenantOverview.tsx — the customer-360 usage/health card on a tenant's detail (13a Area 3, 13 §3.3): reveal
// activity over the last 30 days and all-time, the last reveal, and any active abuse holds — the at-a-glance
// support context. Read-only PII-free aggregate from the audited api. Renders async state through the State Kit.
"use client";

import { StatTile, StateSwitch } from "@leadwolf/ui";
import { useCallback, useEffect, useState } from "react";
import { fetchTenantOverview } from "../api";
import { shortDate } from "../format";
import type { TenantOverview as TenantOverviewData } from "../types";

export function TenantOverview({ tenantId }: { tenantId: string }) {
  const [data, setData] = useState<TenantOverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchTenantOverview(tenantId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load overview");
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div style={{ marginBottom: 24 }}>
      <h3 className="tp-section-title" style={{ marginBottom: 12 }}>
        Overview
      </h3>
      <StateSwitch loading={loading} error={error} onRetry={() => void reload()}>
        {data ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
              gap: 12,
            }}
          >
            <StatTile label="Reveals (30d)" value={data.reveals30d.toLocaleString()} />
            <StatTile label="Credits burned (30d)" value={data.burn30d.toLocaleString()} />
            <StatTile label="Reveals (all time)" value={data.revealsTotal.toLocaleString()} />
            <StatTile
              label="Last reveal"
              value={data.lastRevealAt ? shortDate(data.lastRevealAt) : "—"}
            />
            <StatTile
              label="Active holds"
              value={data.activeHolds.toLocaleString()}
              sublabel={data.activeHolds > 0 ? "org is on hold" : undefined}
            />
          </div>
        ) : null}
      </StateSwitch>
    </div>
  );
}
