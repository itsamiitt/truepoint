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

  try {
    deps.storage.setItem(LOCK_KEY, JSON.stringify({ tabId: deps.tabId, at: now }));
  } catch {
    // The store refused the write — Safari private mode throws on localStorage.setItem, and a cookie store
    // silently drops a Domain the browser rejects. FAIL TOWARD REFRESHING: return true so this tab proceeds.
    // The failure to avoid is not "two tabs refreshed", which is merely the pre-election status quo and is
    // forgiven by the server's rotation grace — it is "every tab stood down and nobody refreshed", which
    // silently expires the session. A lock that cannot be written must never be read as "someone else holds
    // it".
    return true;
  }

  // Write-then-reread. Two tabs passing the check above both write; the last write wins and the other sees a
  // foreign id here and stands down. This is the whole of the mutual exclusion, and it is why the comment at
  // the top calls the election sloppy rather than correct.
  const confirmed = readClaim(deps.storage);
  // A write that reported success but reads back as ABSENT means the store is not functioning as one (a
  // rejected cookie domain is the realistic case). Same reasoning as the catch above — proceed rather than
  // let a broken lock convince every tab to stand down. A foreign id, by contrast, is the election working:
  // someone else won, so stand down.
  if (confirmed === null) return true;
  return confirmed.tabId === deps.tabId;
}

// ── Cross-ORIGIN election (the shared-domain lock cookie) ───────────────────────────────────────────────
//
// THE DEFECT THIS CLOSES. localStorage is scoped per ORIGIN, so the election above only ever elected among
// one app's tabs. But the refresh cookie is host-scoped to the auth origin, which means app./admin./forge
// share ONE cookie — a resource none of them could see the others contending for. Two of those apps open in
// the same browser therefore rotated the same cookie concurrently, every time, by construction. The server
// forgives that race now (ConcurrentRotationError leaves the cookie alone) and the client retries through
// it, but forgiving a race is not the same as not having one: the loser still burns a round-trip, and on a
// cold load it can still reach the login redirect before the retry helps.
//
// A cookie on the shared parent domain is the only coordination channel these three origins actually have.
// BroadcastChannel, localStorage, SharedWorker and the Web Locks API are all origin-scoped by design; a
// cookie is the one browser store keyed by DOMAIN rather than by origin.
//
// It holds no secret — a tab id and a timestamp, the same claim the localStorage path writes — so it is
// deliberately NOT HttpOnly (script has to read and write it) and its readability is not a weakness. It is
// short-lived (Max-Age = the lock TTL) so an abandoned claim disappears on its own even if a tab dies
// without releasing it.
const LOCK_COOKIE = "tp_refresh_lock";

/**
 * The parent domain to scope the lock cookie to, derived from an app origin by dropping the leftmost label:
 * `https://app.truepoint.in` → `.truepoint.in`, which app./admin./forge all match.
 *
 * Derived rather than configured because every alternative is worse in this codebase: a new NEXT_PUBLIC_ env
 * would need adding to three apps, the compose file, the production template and the Dockerfiles, and would
 * be one more thing that can be set wrong in exactly the way nobody notices. Returns null when there is no
 * parent to speak of (localhost, an IP, a bare apex) so the caller falls back to localStorage.
 *
 * A WRONG guess is safe, which is what makes deriving acceptable. Browsers refuse a Domain that is not a
 * suffix of the current host, and refuse a public suffix outright, so the cookie simply never sets — and
 * tryAcquireRefreshLock reads an unwritable store as "proceed", degrading to the per-origin behaviour this
 * replaces rather than to a wedged one.
 */
export function lockCookieDomain(appOrigin: string): string | null {
  let host: string;
  try {
    host = new URL(appOrigin).hostname;
  } catch {
    return null;
  }
  if (/^\d+(\.\d+)*$/.test(host) || host === "localhost") return null; // IP or bare host: no parent
  const labels = host.split(".");
  if (labels.length < 3) return null; // already an apex (truepoint.in) — nothing to widen to
  return `.${labels.slice(1).join(".")}`;
}

/** An ElectionStorage backed by `document.cookie` on `domain`, so the claim is visible to every subdomain. */
export function createCookieLockStorage(domain: string): ElectionStorage {
  const read = (key: string): string | null => {
    for (const part of document.cookie.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === key) return decodeURIComponent(v.join("="));
    }
    return null;
  };
  return {
    getItem: (key) => (key === LOCK_KEY ? read(LOCK_COOKIE) : null),
    setItem: (key, value) => {
      if (key !== LOCK_KEY) return;
      // Max-Age is the lock TTL: a tab that dies mid-refresh cannot leave a claim that outlives its own
      // validity window. SameSite=Lax rather than Strict so the claim survives a top-level navigation back
      // from the auth origin (the login redirect), which is exactly when a fresh refresh is about to happen.
      document.cookie = `${LOCK_COOKIE}=${encodeURIComponent(value)}; Domain=${domain}; Path=/; Max-Age=${Math.ceil(LOCK_TTL_MS / 1000)}; SameSite=Lax; Secure`;
    },
    removeItem: (key) => {
      if (key !== LOCK_KEY) return;
      document.cookie = `${LOCK_COOKIE}=; Domain=${domain}; Path=/; Max-Age=0; SameSite=Lax; Secure`;
    },
  };
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
