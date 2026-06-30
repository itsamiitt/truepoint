// BillingPage.tsx — the customer Billing & Credits HUB (OD-3): a tabbed surface over the tenant's plan,
// credits, usage history, invoices and subscription. Plan/Credits/Usage are live; Invoices and Subscription
// are defer-honest placeholders ([Stripe]/[decision-gated]). This is the feature's public component, rendered
// by the thin (shell)/settings/billing route; the top-bar credit pill deep-links here (lands on Credits).
// Tab selection is mirrored to ?tab= via history.replaceState (no useSearchParams Suspense constraint).
"use client";

import { StateSwitch, Tabs } from "@leadwolf/ui";
import { useEffect, useState } from "react";
import styles from "../billing.module.css";
import { useBilling } from "../hooks/useBilling";
import { BillingTab, DEFAULT_BILLING_TAB, readBillingTabFromUrl } from "../tabs";
import { CreditsTab } from "./tabs/CreditsTab";
import { PlaceholderTab } from "./tabs/PlaceholderTab";
import { PlanTab } from "./tabs/PlanTab";
import { UsageTab } from "./tabs/UsageTab";

const TAB_ITEMS = [
  { value: BillingTab.Plan, label: "Plan" },
  { value: BillingTab.Credits, label: "Credits" },
  { value: BillingTab.Usage, label: "Usage" },
  { value: BillingTab.Invoices, label: "Invoices" },
  { value: BillingTab.Subscription, label: "Subscription" },
];

export function BillingPage() {
  const { balance, usage, plan, error, loading, reload, topUp } = useBilling();
  // Initial render uses the default (SSR-safe); the effect syncs the deep-linked ?tab= on the client.
  const [tab, setTab] = useState<string>(DEFAULT_BILLING_TAB);
  useEffect(() => setTab(readBillingTabFromUrl()), []);

  const onTab = (value: string) => {
    setTab(value);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("tab", value);
    window.history.replaceState(null, "", url.toString());
  };

  return (
    <section>
      <h1 className="tp-settings-title">Billing &amp; credits</h1>

      <Tabs
        items={TAB_ITEMS}
        value={tab}
        onChange={onTab}
        aria-label="Billing sections"
        className={styles.tabBar}
      />

      <div className={styles.page}>
        {tab === BillingTab.Invoices ? (
          <PlaceholderTab
            title="Invoices coming with billing"
            description="Itemized invoices and receipts will appear here once card billing is enabled."
          />
        ) : tab === BillingTab.Subscription ? (
          <PlaceholderTab
            title="You're on month-to-month"
            description="No auto-renewal, no lock-in — credits never expire. Subscription and cancel controls arrive with recurring billing."
          />
        ) : (
          <StateSwitch loading={loading} error={error} onRetry={reload}>
            {tab === BillingTab.Plan && <PlanTab plan={plan} />}
            {tab === BillingTab.Credits && <CreditsTab balance={balance} topUp={topUp} />}
            {tab === BillingTab.Usage && <UsageTab usage={usage} />}
          </StateSwitch>
        )}
      </div>
    </section>
  );
}
