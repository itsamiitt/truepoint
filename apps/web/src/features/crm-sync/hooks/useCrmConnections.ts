// useCrmConnections.ts — the workspace's CRM connections (GET /crm/connections). Server state only.
"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchCrmConnections } from "../api";
import { crmSyncKeys } from "../keys";
import type { CrmConnectionView } from "../types";

export function useCrmConnections() {
  const query = useQuery<CrmConnectionView[]>({
    queryKey: crmSyncKeys.connections(),
    queryFn: fetchCrmConnections,
  });

  return {
    connections: query.data ?? null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load your CRM connections"
      : null,
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
  };
}
