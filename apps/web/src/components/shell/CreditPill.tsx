// CreditPill.tsx — the top-bar tenant credit balance (11 §1 "Credits is not a tab"). Fetches the balance
// via fetchWithAuth and deep-links into Settings ▸ Billing & Credits; the dot turns warning-amber when the
// balance runs low. Re-fetches whenever the reveal flow dispatches the "credits:changed" window event so
// the pill stays truthful right after a spend (the one place credits change in the prospect surface).
"use client";

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

const LOW_BALANCE = 20;

export function CreditPill() {
  const [balance, setBalance] = useState<number | null>(null);

  const load = useCallback(async () => {
    const res = await fetchWithAuth(`${API_BASE}/api/v1/credits/balance`);
    if (res.ok) {
      const data = (await res.json()) as { balance: number };
      setBalance(data.balance);
    }
  }, []);

  useEffect(() => {
    void load();
    const onChange = () => void load();
    window.addEventListener("credits:changed", onChange);
    return () => window.removeEventListener("credits:changed", onChange);
  }, [load]);

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
