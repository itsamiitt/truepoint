// InvoicesTab.tsx — the billing hub's Invoices tab (Phase 3, M11 / ADR-0041). Stripe hosts the authoritative
// invoices/receipts (PDFs, payment method) in the billing portal, so this tab points there rather than
// re-implementing invoice rendering. The "Credit history" tab already shows the in-app credit ledger.
"use client";

import { Card, TpButton, useToast } from "@leadwolf/ui";
import { useState } from "react";
import { openBillingPortal } from "../../api";

export function InvoicesTab() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setBusy(true);
    try {
      const url = await openBillingPortal();
      if (url) window.location.assign(url);
      else toast.error("Invoices aren't available yet.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not open the billing portal");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ padding: 24 }}>
      <p className="app-muted" style={{ fontSize: 13, marginTop: 0 }}>
        Your invoices and receipts live in the billing portal, where you can download PDFs and
        update your payment method. Your in-app credit movements are on the Credit history tab.
      </p>
      <TpButton variant="secondary" size="sm" loading={busy} onClick={() => void open()}>
        View invoices
      </TpButton>
    </Card>
  );
}
