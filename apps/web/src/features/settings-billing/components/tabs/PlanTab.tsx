// PlanTab.tsx — the billing hub's Plan tab: plan tier + seat/workspace usage StatTiles, plus the entitlements
// the plan grants. Pure presentation; the plan envelope comes from useBilling (GET /credits/me) via the parent.
"use client";

import { StatTile, StatusBadge } from "@leadwolf/ui";
import { Check } from "lucide-react";
import styles from "../../billing.module.css";
import { TIER_LABEL, type TenantPlan, formatQuota } from "../../types";

function humanizeFeature(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export function PlanTab({ plan }: { plan: TenantPlan | null }) {
  const tierLabel = plan ? (plan.planName ?? TIER_LABEL[plan.tier] ?? plan.tier) : null;
  const features = plan?.features
    ? Object.entries(plan.features)
        .filter(([, on]) => on)
        .map(([k]) => humanizeFeature(k))
    : [];

  return (
    <div className={styles.tabStack}>
      <div className={styles.tiles}>
        <StatTile
          label="Plan"
          value={tierLabel ?? "—"}
          sublabel={plan ? "Your current plan" : "Plan unavailable"}
          trend={tierLabel ? <StatusBadge tone="success">Active</StatusBadge> : undefined}
        />
        <StatTile
          label="Seats"
          value={plan ? formatQuota(plan.seatsUsed, plan.seatLimit) : "—"}
          sublabel="Members on this tenant"
        />
        <StatTile
          label="Workspaces"
          value={plan ? formatQuota(plan.workspacesUsed, plan.workspaceLimit) : "—"}
          sublabel="Created under your plan"
        />
      </div>

      {features.length > 0 && (
        <div>
          <span className={styles.cardLabel}>Included</span>
          <ul className={styles.featureList}>
            {features.map((f) => (
              <li key={f} className={styles.featureItem}>
                <Check size={15} aria-hidden className={styles.featureCheck} />
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
