// useSendingDomains.ts — the sending-domains list plus the per-row verify action (M12, email-planning/13 P0).
// `verifyingId` disables just the row being verified, and a successful verify re-reads the list from the
// server — whether a domain now counts as verified is the server's answer, not something to infer locally.
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchSendingDomains, verifySendingDomain } from "../api";
import { settingsMailboxKeys } from "../keys";

export function useSendingDomains() {
  const qc = useQueryClient();
  const key = settingsMailboxKeys.sendingDomains();
  const query = useQuery({ queryKey: key, queryFn: fetchSendingDomains });

  const verify = useMutation({
    mutationFn: verifySendingDomain,
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  return {
    domains: query.data?.items ?? [],
    available: query.data?.available ?? true,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load sending domains"
      : null,
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
    verify: async (id: string): Promise<boolean> => {
      try {
        await verify.mutateAsync(id);
        return true;
      } catch {
        // Reported through actionError below — a failed verify is a row-level problem, not a page error.
        return false;
      }
    },
    verifyingId: verify.isPending ? (verify.variables ?? null) : null,
    actionError: verify.error
      ? verify.error instanceof Error
        ? verify.error.message
        : "Could not verify the domain"
      : null,
  };
}
