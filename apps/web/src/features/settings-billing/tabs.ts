// tabs.ts — the billing hub's tab vocabulary + the ?tab= deep-link contract. A valid tab key selects that
// panel; anything else (absent/unknown) falls back to Credits — the customer's most-checked datum and the
// shell CreditPill's deep-link target.

export const BillingTab = {
  Plan: "plan",
  Credits: "credits",
  Usage: "usage",
  Invoices: "invoices",
  Subscription: "subscription",
} as const;

export type BillingTabValue = (typeof BillingTab)[keyof typeof BillingTab];

export const DEFAULT_BILLING_TAB: BillingTabValue = BillingTab.Credits;

const VALID_TABS = new Set<string>(Object.values(BillingTab));

/** Read the ?tab= deep-link from the current URL; unknown/absent → default Credits. Client-only. */
export function readBillingTabFromUrl(): BillingTabValue {
  if (typeof window === "undefined") return DEFAULT_BILLING_TAB;
  const t = new URLSearchParams(window.location.search).get("tab");
  return t && VALID_TABS.has(t) ? (t as BillingTabValue) : DEFAULT_BILLING_TAB;
}
