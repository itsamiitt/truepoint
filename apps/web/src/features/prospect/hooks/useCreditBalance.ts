// useCreditBalance.ts — reads the tenant's reveal-credit balance for the bulk bar and keeps it live by
// re-reading on the "credits:changed" window event (the same signal the top-bar CreditPill listens to, so
// the bar and the pill never drift). Presentation state only; the authoritative balance is server-side
// (07 §3) — the UI never computes or mutates it.
"use client";

import { useCallback, useEffect, useState } from "react";
import { getCreditBalance } from "../api";

export function useCreditBalance() {
  const [balance, setBalance] = useState<number | null>(null);

  const reload = useCallback(async () => {
    try {
      setBalance(await getCreditBalance());
    } catch {
      // A balance read failure must never block selection/reveal — the bar simply shows "—".
      setBalance(null);
    }
  }, []);

  useEffect(() => {
    void reload();
    const onChange = () => void reload();
    window.addEventListener("credits:changed", onChange);
    return () => window.removeEventListener("credits:changed", onChange);
  }, [reload]);

  return { balance, reload };
}
