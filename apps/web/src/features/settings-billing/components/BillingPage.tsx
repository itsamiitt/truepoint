// BillingPage.tsx — the Billing & Credits surface (12 §4): plan tier + seats/workspace StatTiles, the
// credit-pool balance with a Stripe top-up (toasts "coming soon" until checkout is wired), the
// transparent-billing reassurance, and the itemized usage history on the foundation DataTable. This is the
// feature's public component, rendered by the thin (shell)/settings/billing route; the top-bar credit pill
// deep-links here. Presentation + view state only — data loads via useBilling → api.
"use client";

import {
  Card,
  EmptyState,
  StatTile,
  StateSwitch,
  StatusBadge,
  TpButton,
  useToast,
} from "@leadwolf/ui";
import { CreditCard, Wallet } from "lucide-react";
import { useState } from "react";
import { useBilling } from "../hooks/useBilling";
import { TIER_LABEL, formatQuota } from "../types";
import { UsageTable } from "./UsageTable";
import styles from "../billing.module.css";

/** The default top-up pack — packs/pricing are server-driven (07 §1); this is only the checkout seed. */
const TOPUP_PACK = "pack_500";

export function BillingPage() {
  const toast = useToast();
  const { balance, usage, plan, error, loading, reload, topUp } = useBilling();
  const [toppingUp, setToppingUp] = useState(false);

  const onTopUp = async () => {
    setToppingUp(true);
    try {
      const url = await topUp(TOPUP_PACK);
      if (url) window.location.assign(url);
      else
        toast.toast({
          title: "Top-up coming soon",
          description: "Stripe checkout isn't wired yet — credits top up here once it ships.",
        });
    } catch (e) {
      toast.error("Could not start checkout", e instanceof Error ? e.message : undefined);
    } finally {
      setToppingUp(false);
    }
  };

  const tierLabel = plan ? (TIER_LABEL[plan.tier] ?? plan.tier) : null;

  return (
    <section>
      <h1 className="tp-settings-title">Billing &amp; credits</h1>

      <StateSwitch loading={loading} error={error} onRetry={reload}>
        <div className={styles.page}>
          <p className={styles.lede}>
            Your shared credit pool, what it&apos;s been spent on, and how top-ups work.
          </p>

          {/* Plan + seats — weight/size hierarchy, no color (StatTiles). */}
          <div className={styles.tiles}>
            <StatTile
              label="Plan"
              value={tierLabel ?? "—"}
              sublabel={plan ? "Tenant subscription" : "Connect the plan API to show your tier"}
              trend={
                tierLabel ? <StatusBadge tone="success">Active</StatusBadge> : undefined
              }
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

          {/* Credit pool — the one place accent color is allowed (the balance number). */}
          <Card style={{ padding: 24 }}>
            <div className={styles.cardHead}>
              <span className={styles.cardLabel}>
                <Wallet size={14} aria-hidden />
                Credit balance
              </span>
            </div>
            <div className={styles.balanceRow}>
              <div>
                <span className={styles.balanceNumber}>{(balance ?? 0).toLocaleString()}</span>
                <span className={styles.balanceUnit}>credits available</span>
              </div>
              <TpButton variant="secondary" leftIcon={<CreditCard size={15} />} loading={toppingUp} onClick={onTopUp}>
                Top up
              </TpButton>
            </div>
            <p className={styles.note}>
              <span className={styles.noteDot} aria-hidden="true" />
              <span>You&apos;re only charged for verified data; bounces are credited back.</span>
            </p>
          </Card>

          {/* Usage history — DataTable with its own empty state. */}
          <Card style={{ padding: 24 }}>
            <div className={styles.cardHead}>
              <span className={styles.cardLabel}>Usage history</span>
            </div>
            <StateSwitch
              empty={usage.length === 0}
              emptyState={
                <EmptyState
                  title="No reveals yet"
                  description="When you reveal a contact, each charge shows up here — fully itemized."
                />
              }
            >
              <UsageTable reveals={usage} />
            </StateSwitch>
          </Card>
        </div>
      </StateSwitch>
    </section>
  );
}
