// useHomeSummary.ts — loads the Home cockpit summary (GET /home/summary) with loading/error state and a
// `reload`. Presentation state only; the shape comes from @leadwolf/types.
//
// Caching (perf): the app has no React Query/SWR, so this hook keeps a tiny module-level cache (the last
// HomeSummary + its server ETag) so a remount/revisit serves the cached value immediately and revalidates in
// the background (stale-while-revalidate) instead of a cold refetch. Revalidation sends If-None-Match, so an
// unchanged summary comes back as a cheap 304 and we keep the cached value. Concurrent callers share one
// in-flight request (single-flight dedup) so the shell mounting the hook twice fires one network call.
"use client";

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import { useCallback, useEffect, useState } from "react";
import type { HomeSummary } from "../types";

const ENDPOINT = `${API_BASE}/api/v1/home/summary`;

// Module-level cache: survives unmount/remount within a session (cleared on full reload / workspace switch,
// which reloads the page). Per-user by construction — the in-memory token scopes every fetch to one session.
let cached: { summary: HomeSummary; etag: string | null } | null = null;
let inFlight: Promise<HomeSummary> | null = null;

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

async function fetchSummary(): Promise<HomeSummary> {
  const headers = new Headers();
  if (cached?.etag) headers.set("if-none-match", cached.etag);
  const res = await fetchWithAuth(ENDPOINT, { headers });

  if (res.status === 304 && cached) return cached.summary; // unchanged — keep what we have
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load your workspace summary"));

  const summary = (await res.json()) as HomeSummary;
  cached = { summary, etag: res.headers.get("etag") };
  return summary;
}

/** Fetch (or revalidate) the summary; sends If-None-Match and treats 304 as "keep cached". Deduped. */
function loadHomeSummary(): Promise<HomeSummary> {
  if (inFlight) return inFlight;
  const request = fetchSummary();
  inFlight = request;
  // Clear the single-flight slot once settled so the next mount can revalidate (without swallowing errors).
  void request.finally(() => {
    if (inFlight === request) inFlight = null;
  });
  return request;
}

export function useHomeSummary() {
  const [summary, setSummary] = useState<HomeSummary | null>(() => cached?.summary ?? null);
  const [error, setError] = useState<string | null>(null);
  // Only show the cold spinner when we have nothing to render; otherwise revalidate behind the stale value.
  const [loading, setLoading] = useState(() => cached === null);

  const reload = useCallback(async () => {
    if (cached === null) setLoading(true);
    setError(null);
    try {
      setSummary(await loadHomeSummary());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load your workspace summary");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { summary, error, loading, reload };
}
