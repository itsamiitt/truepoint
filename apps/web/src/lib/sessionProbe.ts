// sessionProbe.ts — ONE shared, de-duplicated read of GET /api/v1/auth/session.
//
// Four independent consumers used to fetch this endpoint themselves — AppShell (to fill the sidebar and to
// detect a server-side revocation), WorkspaceSwitcher (for the active workspace id), useSessionIdentity, and
// useSessionRole — so a single page load issued the same request 2-4 times, every time, with no cache. They all
// mount inside the shell, so the duplicates were concurrent rather than spread out.
//
// This is a plain module-level single-flight cache rather than a TanStack query, deliberately: the shared lib
// layer states it stays TanStack-free, and honouring that is cheaper than making the auth gate depend on a
// provider that mounts inside it.
//
// Cache lifetime is the page. That is correct today because switching workspace or org does a full
// `window.location.reload()` (see authClient), which discards module state along with everything else. If that
// ever becomes a client-side transition, call invalidateSessionProbe() from the switch path.
//
// Only SUCCESSES are cached. A transient failure clears the slot so a later consumer retries, instead of one
// unlucky probe leaving the sidebar permanently empty for the rest of the page's life.
"use client";

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { WorkspaceRole } from "@leadwolf/types";

/** One entry of the folded workspace directory — the switcher's option shape (same as GET /workspaces). */
export interface SessionWorkspace {
  id: string;
  name: string;
  role: WorkspaceRole;
}

/** The session profile the API returns. Presentation only — the server re-checks authorization on every call. */
export interface SessionProfile {
  userId: string;
  tenantId: string;
  workspaceId: string | null;
  role: string | null;
  scope: string[];
  /** The caller's workspace directory, folded into the boot probe via ?include=workspaces (perf-audit
   *  P3.5b) so the switcher's first load costs no second request. Absent on servers that predate the fold. */
  workspaces?: SessionWorkspace[];
}

/** Discriminated result. `status` is surfaced because AppShell must treat 401/403 as a revoked session (clear
 *  the token and re-gate to login) rather than as a cosmetic miss; `status: 0` means the request never landed. */
export type SessionProbeResult =
  | { ok: true; session: SessionProfile }
  | { ok: false; status: number };

let inFlight: Promise<SessionProbeResult> | null = null;

async function probe(): Promise<SessionProbeResult> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/auth/session?include=workspaces`);
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, session: (await res.json()) as SessionProfile };
}

/** Read the session profile, sharing one request across all callers on this page. */
export function getSessionProbe(): Promise<SessionProbeResult> {
  if (inFlight) return inFlight;
  const pending = probe().catch((): SessionProbeResult => ({ ok: false, status: 0 }));
  inFlight = pending.then((result) => {
    // Keep a success cached; drop a failure so the next consumer can try again.
    if (!result.ok) inFlight = null;
    return result;
  });
  return inFlight;
}

/** Drop the cached profile — call after anything that changes the active tenant/workspace without a reload. */
export function invalidateSessionProbe(): void {
  inFlight = null;
}
