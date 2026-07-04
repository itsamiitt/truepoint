// providers.tsx — the app's client-side provider stack, mounted once by the root layout. Today it carries
// exactly one provider: the TanStack Query client (import-redesign 11 §8.2 — S-U1 is the adoption point:
// dep + provider only). New server-state hooks ship TanStack-shaped from here on; the shipped
// useState+useEffect pollers migrate only as their surfaces are rebuilt (S-U2/S-U3) — no big-bang rewrite.
"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

export function Providers({ children }: { children: ReactNode }) {
  // One client per browser session, created lazily in state so a re-render never resets the cache.
  // Deliberately default options — per-surface behavior (poll cadence, retries) is pinned per hook (11 §8.2).
  const [client] = useState(() => new QueryClient());
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
