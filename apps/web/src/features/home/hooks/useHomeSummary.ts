// useHomeSummary.ts — loads the Home cockpit summary (GET /home/summary). Presentation state only; the shape
// comes from @leadwolf/types.
//
// This used to hand-roll stale-while-revalidate, single-flight dedup and a module-level cache in ~50 lines,
// because the app had no query layer when it was written. It does now, and TanStack Query gives all three for
// free — so the hand-rolled versions were not just redundant but strictly worse: the module cache was never
// invalidated by anything (a workspace switch relied on a full page reload to clear it) and nothing else in
// the app could read or refresh the value it held.
//
// The ONE thing RQ does not do for us is the conditional request, so that is kept: revalidation sends
// If-None-Match, and an unchanged summary comes back as a cheap 304 whose body we must not parse. The stored
// ETag is paired with the cached entry — if RQ has evicted the data, the header is not sent, because a 304
// with nothing to fall back to would leave the query with no value at all.
"use client";

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { homeKeys } from "../keys";
import type { HomeSummary } from "../types";

const ENDPOINT = `${API_BASE}/api/v1/home/summary`;

/** The ETag of whatever is currently in the query cache under `homeKeys.summary()`. */
let etag: string | null = null;

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

export function useHomeSummary() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: homeKeys.summary(),
    queryFn: async (): Promise<HomeSummary> => {
      const previous = qc.getQueryData<HomeSummary>(homeKeys.summary());
      const headers = new Headers();
      // Only conditional when there is something to keep — see the header note.
      if (etag && previous) headers.set("if-none-match", etag);
      const res = await fetchWithAuth(ENDPOINT, { headers });

      if (res.status === 304 && previous) return previous; // unchanged — keep what we have
      if (!res.ok)
        throw new Error(await problemMessage(res, "Could not load your workspace summary"));

      etag = res.headers.get("etag");
      return (await res.json()) as HomeSummary;
    },
  });

  return {
    summary: query.data ?? null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load your workspace summary"
      : null,
    // Only the COLD load is a spinner; a background revalidation keeps rendering the stale value, which is
    // the behaviour the hand-rolled cache existed to provide.
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
  };
}
