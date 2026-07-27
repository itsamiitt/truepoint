// refreshElection.ts — one refresh per BROWSER, not one per tab (T-2.6).
//
// Each app's authClient arms its own timer to silently refresh ~60s before the access token expires. With N
// tabs open on the same origin that is N independent rotation chains firing within milliseconds of each
// other, and a refresh is not cheap: every one is a full rotation — a DB revoke + insert plus a Redis write —
// and rotated refresh tokens mean the losers are presenting a token the winner just replaced. Today that only
// survives because of the 30s reuse-grace window; it is a race that happens to be forgiven, not a design.
//
// This elects ONE tab to perform the refresh and broadcasts the result to the rest, so the work and the
// rotation happen once regardless of tab count.
//
// The election is deliberately "sloppy": localStorage has no compare-and-swap, so two tabs can both believe
// they won. The mitigation is write-then-reread — whoever's id survives the reread proceeds. A rare double
// refresh is exactly the status quo, so the failure mode is no worse than not having this; the common case is
// what improves. A stricter primitive (Web Locks) is not used because it is unavailable in enough of the
// supported surface that the fallback path would be the one under test.
//
// Everything is injected — storage, channel, clock, tab id — so the logic is testable without a browser and
// so a surface lacking BroadcastChannel degrades to "every tab refreshes", i.e. today's behaviour.

/** The subset of `Storage` used here. */
export interface ElectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The subset of `BroadcastChannel` used here. */
export interface ElectionChannel {
  postMessage(message: unknown): void;
  close?(): void;
}

/** What the winner shares so the losers do not rotate a second time. */
export interface RefreshResult {
  token: string;
  expiresIn: number;
}

export interface ElectionDeps {
  storage: ElectionStorage;
  /** Absent (no BroadcastChannel) ⇒ no result sharing; every tab refreshes, as it does today. */
  channel?: ElectionChannel;
  now: () => number;
  /** Unique per tab. */
  tabId: string;
}

const LOCK_KEY = "tp.refresh.lock";

/** How long a claim is honoured before another tab may take it. Must exceed a normal refresh round-trip so a
 *  slow-but-live leader is not preempted, and stay short enough that a tab closed mid-refresh does not block
 *  the next attempt past the token's own lifetime. */
export const LOCK_TTL_MS = 10_000;

interface Claim {
  tabId: string;
  at: number;
}

function readClaim(storage: ElectionStorage): Claim | null {
  const raw = storage.getItem(LOCK_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Claim>;
    if (typeof parsed.tabId !== "string" || typeof parsed.at !== "number") return null;
    return { tabId: parsed.tabId, at: parsed.at };
  } catch {
    // A corrupt entry must not wedge refreshing forever — treat it as no claim, so this tab can take over.
    return null;
  }
}

/**
 * Try to become the tab that performs the refresh.
 *
 * Returns true for exactly one tab in the common case. A stale claim (older than LOCK_TTL_MS) is treated as
 * abandoned, which is what stops a tab closed mid-refresh from blocking every other tab indefinitely.
 */
export function tryAcquireRefreshLock(deps: ElectionDeps): boolean {
  const now = deps.now();
  const existing = readClaim(deps.storage);
  if (existing && existing.tabId !== deps.tabId && now - existing.at < LOCK_TTL_MS) {
    return false; // someone else holds a live claim
  }

  deps.storage.setItem(LOCK_KEY, JSON.stringify({ tabId: deps.tabId, at: now }));
  // Write-then-reread. Two tabs passing the check above both write; the last write wins and the other sees a
  // foreign id here and stands down. This is the whole of the mutual exclusion, and it is why the comment at
  // the top calls the election sloppy rather than correct.
  const confirmed = readClaim(deps.storage);
  return confirmed?.tabId === deps.tabId;
}

/** Release a claim this tab holds. Never clears another tab's claim — a late release after being preempted
 *  would otherwise hand a second tab a green light while the preemptor is still refreshing. */
export function releaseRefreshLock(deps: ElectionDeps): void {
  const existing = readClaim(deps.storage);
  if (existing?.tabId === deps.tabId) deps.storage.removeItem(LOCK_KEY);
}

/** Share a completed refresh so other tabs adopt the token instead of rotating again. */
export function broadcastRefreshResult(deps: ElectionDeps, result: RefreshResult): void {
  deps.channel?.postMessage({ type: "tp.refresh.result", ...result });
}

/** Narrow an inbound BroadcastChannel payload to a refresh result. Everything on that channel is untrusted
 *  input from another script on the same origin, so it is validated rather than cast. */
export function parseRefreshMessage(message: unknown): RefreshResult | null {
  if (typeof message !== "object" || message === null) return null;
  const m = message as Record<string, unknown>;
  if (m.type !== "tp.refresh.result") return null;
  if (typeof m.token !== "string" || m.token.length === 0) return null;
  if (typeof m.expiresIn !== "number" || !Number.isFinite(m.expiresIn) || m.expiresIn <= 0) {
    return null;
  }
  return { token: m.token, expiresIn: m.expiresIn };
}
