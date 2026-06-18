// useSalesNavLinks.ts — view state for the Sales Navigator capture surface (05 §5, M7): loads the workspace's
// captured links and exposes capture/remove mutations that keep the list in sync. Presentation state only —
// dedup, parsing, and persistence all happen server-side; the hook just reflects the result.
"use client";

import type { SalesNavLinkDTO, SalesNavLinkRequest } from "@leadwolf/types";
import { useCallback, useEffect, useState } from "react";
import { captureLink, deleteLink, fetchLinks } from "../api";

export interface CaptureOutcome {
  deduped: boolean;
}

export function useSalesNavLinks() {
  const [links, setLinks] = useState<SalesNavLinkDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setLinks(await fetchLinks());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load captured links");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Capture a link, then refresh so the (possibly deduped) row is reflected. Throws on failure. */
  const capture = useCallback(
    async (body: SalesNavLinkRequest): Promise<CaptureOutcome> => {
      const result = await captureLink(body);
      await reload();
      return { deduped: result.deduped };
    },
    [reload],
  );

  /** Optimistically drop the row, then delete server-side; reload to reconcile on failure. */
  const remove = useCallback(
    async (id: string): Promise<void> => {
      const prev = links;
      setLinks((rows) => rows.filter((l) => l.id !== id));
      try {
        await deleteLink(id);
      } catch (e) {
        setLinks(prev); // roll back the optimistic removal
        throw e;
      }
    },
    [links],
  );

  return { links, error, loading, reload, capture, remove };
}
