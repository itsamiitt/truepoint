// providers.tsx — the app's client-side provider stack, mounted once by the root layout. Today it carries
// exactly one provider: the TanStack Query client (import-redesign 11 §8.2 — S-U1 is the adoption point:
// dep + provider only). New server-state hooks ship TanStack-shaped from here on; the shipped
// useState+useEffect pollers migrate only as their surfaces are rebuilt (S-U2/S-U3) — no big-bang rewrite.
"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

export function Providers({ children }: { children: ReactNode }) {
  // One client per browser session, created lazily in state so a re-render never resets the cache.
  //
  // These defaults are deliberate, not decoration. TanStack's own defaults are `staleTime: 0` +
  // `refetchOnWindowFocus: true`, which means every cached read is considered stale the moment it lands and
  // EVERY tab focus refetches every active query — so simply alt-tabbing back into the app re-issued all of
  // them. A short staleTime keeps genuinely fresh data out of the network path while remaining far below any
  // surface's tolerance for staleness, and one retry avoids turning a single blip into a visible error without
  // hiding a real outage behind a long retry chain. Per-surface overrides (poll cadence, longer staleTime for
  // near-static reads) are still pinned per hook (11 §8.2) and win over these.
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
