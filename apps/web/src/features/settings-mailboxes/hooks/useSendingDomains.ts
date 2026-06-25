// useSendingDomains.ts — presentation state for the sending-domains list + the per-row verify action (M12,
// email-planning/13 P0). Vanilla React; per-row in-flight `verifyingId` so the verify button disables just
// that row; quiet reload after add/verify. NOT TanStack Query (14 §3).
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchSendingDomains, verifySendingDomain } from "../api";
import type { SendingDomainView } from "../types";

export function useSendingDomains() {
  const [domains, setDomains] = useState<SendingDomainView[]>([]);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const res = await fetchSendingDomains();
      setDomains(res.items);
      setAvailable(res.available);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load sending domains");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const verify = useCallback(
    async (id: string): Promise<boolean> => {
      setVerifyingId(id);
      setActionError(null);
      try {
        await verifySendingDomain(id);
        await reload();
        return true;
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "Could not verify the domain");
        return false;
      } finally {
        setVerifyingId(null);
      }
    },
    [reload],
  );

  return { domains, available, error, loading, reload, verify, verifyingId, actionError };
}
