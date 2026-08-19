// stubs/next-navigation.tsx — the App Router surface the prospect slice reads URL state through.
//
// The slice keeps search/filter state in the URL (useProspectSearch → searchUrlState), so a dead no-op
// router would freeze every card in its initial state and no filter interaction would do anything. This
// stub instead backs the query string with a tiny in-memory store: router.replace/push write to it and
// notify subscribers, useSearchParams reads it via useSyncExternalStore. The result is a preview card
// where the real URL-state round-trip actually works — clicking a facet re-runs the (fixture-backed)
// search exactly as it does in the app.
//
// `setInitialSearch()` lets a preview open a card in a specific state (e.g. an active filter) without
// faking props the component doesn't take.
import { useSyncExternalStore } from "react";

let search = "";
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Seed the query string before mount — call at module scope in a preview, never during render. */
export function setInitialSearch(qs: string): void {
  search = qs.replace(/^\?/, "");
  emit();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function snapshot(): string {
  return search;
}

function write(url: string): void {
  const q = url.indexOf("?");
  const next = q === -1 ? "" : url.slice(q + 1);
  // A no-op write must NOT notify. The slice syncs its state back to the URL from an effect, so
  // re-emitting an unchanged query string re-runs that effect forever and the page never paints.
  if (next === search) return;
  search = next;
  emit();
}

// One URLSearchParams instance per distinct query string. Identity matters: the slice memoizes and keys
// effects on the object useSearchParams returns, so handing back a fresh instance every render is the
// other half of the same infinite loop.
let cached: URLSearchParams | null = null;
let cachedFor: string | null = null;
function paramsFor(qs: string): URLSearchParams {
  if (!cached || cachedFor !== qs) {
    cached = new URLSearchParams(qs);
    cachedFor = qs;
  }
  return cached;
}

export function useSearchParams(): URLSearchParams {
  // useSyncExternalStore reads the raw string (a stable primitive) — a URLSearchParams snapshot would be a
  // new identity on every read and trip the store's own equality check.
  return paramsFor(useSyncExternalStore(subscribe, snapshot, snapshot));
}

export function usePathname(): string {
  return "/prospect";
}

export interface StubRouter {
  push: (url: string) => void;
  replace: (url: string) => void;
  refresh: () => void;
  back: () => void;
  forward: () => void;
  prefetch: (url: string) => void;
}

const router: StubRouter = {
  push: write,
  replace: write,
  refresh: () => {},
  back: () => {},
  forward: () => {},
  prefetch: () => {},
};

export function useRouter(): StubRouter {
  return router;
}

export function useParams(): Record<string, string> {
  return {};
}
