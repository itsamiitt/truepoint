// useApprovals.ts — loads the pending maker-checker review queue (GET /admin/data/approvals) with loading/error
// state and a `reload` (the admin app's useState convention — NO TanStack). Presentation state only; the typed
// fetch lives in api.ts and the shape is the shared @leadwolf/types ApprovalRequestView.
"use client";

import type { ApprovalRequestView } from "@leadwolf/types";
import { useCallback, useEffect, useState } from "react";
import { fetchPendingApprovals } from "../api";

export function useApprovals() {
  const [approvals, setApprovals] = useState<ApprovalRequestView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setApprovals(await fetchPendingApprovals());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the approvals queue");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { approvals, error, loading, reload };
}
