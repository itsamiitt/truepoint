// CreditPill.tsx — the top-bar tenant credit balance (11 §1 "Credits is not a tab"). Deep-links into
// Settings ▸ Billing & Credits; the dot turns warning-amber when the balance runs low.
//
// The balance comes from the shared `useCreditBalance` query rather than a fetch of its own: the prospect
// bulk bar reads the same endpoint, and two independent copies of one number could show two different values
// in the same viewport for as long as only one of them had re-read after a spend. A reveal now invalidates
// the key and both surfaces update from one request.
"use client";

import { useCreditBalance } from "@/lib/credits";
import Link from "next/link";

const LOW_BALANCE = 20;

export function CreditPill() {
  const { balance } = useCreditBalance();
  const low = balance !== null && balance < LOW_BALANCE;

  return (
    <Link
      className="tp-credit-pill"
      href="/settings/billing"
      title="Billing & Credits"
      aria-label={`${balance ?? "—"} credits — open Billing & Credits`}
    >
      <span className={`tp-credit-dot${low ? " is-low" : ""}`} aria-hidden="true" />
      <span className="tp-credit-amount">{balance === null ? "—" : balance.toLocaleString()}</span>
      <span className="tp-credit-label">credits</span>
    </Link>
  );
}
