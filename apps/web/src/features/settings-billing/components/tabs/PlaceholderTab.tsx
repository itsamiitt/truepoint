// PlaceholderTab.tsx — a defer-honest panel for billing-hub tabs whose backend isn't wired yet (Invoices —
// [Stripe][flag]; Subscription — [decision-gated]). It renders an honest EmptyState rather than a fake live
// view, per the Top-up-stub precedent. No fabricated invoices, no fake subscription state.
"use client";

import { Card, EmptyState } from "@leadwolf/ui";

export function PlaceholderTab({ title, description }: { title: string; description: string }) {
  return (
    <Card style={{ padding: 24 }}>
      <EmptyState title={title} description={description} />
    </Card>
  );
}
