// useReveal.ts — view state for THE money loop (07 §3): runs api.revealContact, holds the busy flag, the
// revealed response (PII + new balance), and a structured failure so the dialog can branch on
// insufficient_credits (402) vs suppressed (403). On success it dispatches the "credits:changed" window
// event so the top-bar CreditPill re-reads the balance. Holds no business logic — the charge/gate run
// server-side in packages/core.
"use client";

import type { RevealResponse, RevealType } from "@leadwolf/types";
import { useCallback, useState } from "react";
import { ApiError, revealContact } from "../api";

/** A reveal failure shaped for the UI: the message + the discriminating code (+ 402 balance/required). */
export interface RevealFailure {
  code: string;
  message: string;
  balance?: number;
  required?: number;
}

function toFailure(e: unknown): RevealFailure {
  if (e instanceof ApiError) {
    const balance = typeof e.extensions.balance === "number" ? e.extensions.balance : undefined;
    const required = typeof e.extensions.required === "number" ? e.extensions.required : undefined;
    return { code: e.code, message: e.message, balance, required };
  }
  return { code: "error", message: e instanceof Error ? e.message : "Reveal failed" };
}

export function useReveal() {
  const [result, setResult] = useState<RevealResponse | null>(null);
  const [failure, setFailure] = useState<RevealFailure | null>(null);
  const [busy, setBusy] = useState(false);

  /** Reset between contacts so a stale reveal/error never bleeds into the next slide-over. */
  const reset = useCallback(() => {
    setResult(null);
    setFailure(null);
    setBusy(false);
  }, []);

  const run = useCallback(
    async (id: string, revealType: RevealType): Promise<RevealResponse | null> => {
      setBusy(true);
      setFailure(null);
      try {
        const res = await revealContact(id, revealType);
        setResult(res);
        // The pill re-reads the tenant balance off this event (the one place credits change here).
        window.dispatchEvent(new Event("credits:changed"));
        return res;
      } catch (e) {
        setFailure(toFailure(e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  return { result, failure, busy, run, reset };
}
