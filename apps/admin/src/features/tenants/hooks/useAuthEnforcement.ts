// useAuthEnforcement.ts — the mutation state (idle/pending/error) for a tenant's per-tenant P1-01
// enforcement master switch. The typed POST lives in api.ts (the existing audited admin endpoint); this hook
// only tracks the in-flight status so the card can disable controls + surface failures. Presentation state.
"use client";

import { useCallback, useState } from "react";
import { setAuthEnforcement } from "../api";

export type EnforcementMutationStatus = "idle" | "pending" | "error";

export function useAuthEnforcement(tenantId: string) {
  const [status, setStatus] = useState<EnforcementMutationStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  // Returns the server's resulting state on success, or null on failure (the error is exposed via `error`).
  const submit = useCallback(
    async (enabled: boolean): Promise<boolean | null> => {
      setStatus("pending");
      setError(null);
      try {
        const next = await setAuthEnforcement(tenantId, enabled);
        setStatus("idle");
        return next;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not update auth enforcement");
        setStatus("error");
        return null;
      }
    },
    [tenantId],
  );

  return { status, error, submit };
}
