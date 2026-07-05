// AuthModule — the facade (doc 12 §6, ADR-0045). Primary model = COMPANION TAB: login() opens the real web
// login in a BACKGROUND (inactive) tab, so an already-signed-in user is verified silently; the handoff (an
// extension-scoped token) arrives via an origin+nonce-verified externally_connectable message applied by the
// SW's persistent listener (→ applyHandoff), so it completes even if the worker died mid-login. Silent refresh
// uses a SW-held ROTATING refresh token (chrome.storage.session — survives worker death, cleared on browser
// close) and needs NO tab. No launchWebAuthFlow, no PKCE.
import { EXT_TOKEN_BASE } from "../../shared/env.ts";
import type { AccountDisplay, AuthState, OrgSummary } from "../../shared/messages.ts";
import { clearSession, getSession, setSession } from "../../shared/storage.ts";
import { fetchAccount } from "./account.ts";
import {
  type HandoffTokens,
  activateTab,
  closeTab,
  openCompanionTab,
  randomNonce,
} from "./companionTab.ts";
import {
  clearRefreshToken,
  loadRefreshToken,
  refreshTokens,
  saveRefreshToken,
} from "./refreshToken.ts";
import { TokenStore } from "./tokenStore.ts";

const REFRESH_SKEW_MS = 60_000;
const PENDING_AUTH_KEY = "pending_auth";

/** A login in progress: the tab we opened + the nonce the handoff must echo. Kept in storage.session so the
 *  handoff still completes if the worker dies while the user is logging in (the persistent listener wakes it). */
interface PendingAuth {
  state: string;
  tabId: number | null;
}

export interface AuthDeps {
  /** The SW schedules/clears the `auth-refresh` alarm from the new expiry (null = clear). Doc 12 §6.2. */
  onTokenChanged(expiresAtMs: number | null): void;
  /** Fired when derived state changes off the token path (the async account lookup) so the SW re-broadcasts. */
  onStateChanged?(): void;
}

export class AuthModule {
  private readonly tokens = new TokenStore();
  private account: AccountDisplay | null = null;
  private refreshInFlight: Promise<boolean> | null = null;
  private flowLock: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: AuthDeps) {}

  /** On worker wake: if a rotating refresh token survived (storage.session), refresh silently. */
  async init(): Promise<void> {
    if (await loadRefreshToken()) {
      await this.refresh();
    }
  }

  /** Used by ApiClient before every request; refreshes if the token is missing/near-expiry. */
  async getAccessToken(): Promise<string | null> {
    if (this.tokens.isFresh(REFRESH_SKEW_MS)) {
      return this.tokens.raw;
    }
    if (await this.refresh()) {
      return this.tokens.raw;
    }
    // Refresh failed (e.g. a transient auth-service blip). We refresh early (60s skew), so a token that has
    // not ACTUALLY expired yet is still usable; otherwise we are signed out.
    return this.tokens.raw && Date.now() < this.tokens.expiresAt ? this.tokens.raw : null;
  }

  /** Force a silent refresh (ApiClient 401-retry + the alarm pre-refresh). True only when a token is fresh. */
  async refreshNow(): Promise<boolean> {
    return this.refresh();
  }

  get tenantId(): string | null {
    return this.tokens.tenantId;
  }

  get workspaceId(): string | null {
    return this.tokens.workspaceId;
  }

  get sessionId(): string | null {
    return this.tokens.sessionId;
  }

  getState(): AuthState {
    if (!this.tokens.raw) {
      return {
        status: "signed_out",
        account: null,
        tenantId: null,
        workspaceId: null,
        credits: null,
      };
    }
    return {
      status: "signed_in",
      account: this.account?.email ?? this.account?.name ?? null,
      tenantId: this.tokens.tenantId,
      workspaceId: this.tokens.workspaceId,
      credits: null,
    };
  }

  /** Start login — open the handoff page in a BACKGROUND tab and record the pending nonce/tab. The sign-in
   *  completes ASYNCHRONOUSLY via the persistent onMessageExternal handler (→ applyHandoff), which is what
   *  lets an interactive login outlive the service worker. Returns the current (pending) state. */
  async login(): Promise<AuthState> {
    const state = randomNonce();
    const tabId = await openCompanionTab(state);
    const pending: PendingAuth = { state, tabId: tabId ?? null };
    await setSession(PENDING_AUTH_KEY, pending);
    return this.getState();
  }

  /** The expected nonce for the in-progress login (the persistent handler validates against it). */
  async pendingState(): Promise<string | null> {
    return (await getSession<PendingAuth>(PENDING_AUTH_KEY))?.state ?? null;
  }

  /** Login UI is needed — bring the pending background tab to the foreground. */
  async activatePendingTab(): Promise<void> {
    const pending = await getSession<PendingAuth>(PENDING_AUTH_KEY);
    if (pending?.tabId != null) {
      await activateTab(pending.tabId);
    }
  }

  /** Apply a verified handoff (persistent handler), then close the login tab and clear the pending marker. */
  async applyHandoff(tokens: HandoffTokens): Promise<void> {
    await this.serialize(() => this.apply(tokens));
    const pending = await getSession<PendingAuth>(PENDING_AUTH_KEY);
    if (pending?.tabId != null) {
      closeTab(pending.tabId);
    }
    await clearSession(PENDING_AUTH_KEY);
  }

  async logout(): Promise<AuthState> {
    // Best-effort server revoke of the extension refresh-token family; local clear is guaranteed.
    const rt = await loadRefreshToken();
    if (rt) {
      try {
        await fetch(`${EXT_TOKEN_BASE}/logout`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshToken: rt }),
          signal: AbortSignal.timeout(8_000),
        });
      } catch {
        // best-effort
      }
    }
    this.tokens.clear();
    this.account = null;
    await clearRefreshToken();
    this.deps.onTokenChanged(null);
    return this.getState();
  }

  /** Re-mint with a new workspace (doc 12 §6) — a scoped refresh, serialized so a concurrent plain refresh
   *  can't clobber the switched scope. */
  async switchWorkspace(workspaceId: string): Promise<AuthState> {
    try {
      await this.serialize(() => this.doRefresh({ workspaceId }));
    } catch {
      // keep current session on failure
    }
    return this.getState();
  }

  async switchOrg(tenantId: string): Promise<AuthState> {
    try {
      await this.serialize(() => this.doRefresh({ tenantId }));
    } catch {
      // keep current session on failure
    }
    return this.getState();
  }

  /** List the user's orgs. `/auth/orgs` is cookie-based (cross-origin); read via a Bearer API mirror.
   *  TODO(net-new, doc 12 §8): GET /api/v1/orgs. */
  async listOrgs(): Promise<{ orgs: OrgSummary[]; activeTenantId: string | null }> {
    return { orgs: [], activeTenantId: this.tokens.tenantId };
  }

  /** Single-flight silent refresh: concurrent callers share one attempt, serialized against login/switch. */
  private refresh(): Promise<boolean> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }
    this.refreshInFlight = this.serialize(async () => {
      // A login/switch we queued behind may have just applied a fresh token — skip a redundant refresh.
      if (this.tokens.isFresh(REFRESH_SKEW_MS)) {
        return true;
      }
      return this.doRefresh();
    })
      .catch(() => false)
      .finally(() => {
        this.refreshInFlight = null;
      });
    return this.refreshInFlight;
  }

  private async doRefresh(scope?: { workspaceId?: string; tenantId?: string }): Promise<boolean> {
    const rt = await loadRefreshToken();
    if (!rt) {
      return false;
    }
    await this.apply(await refreshTokens(rt, scope));
    return true;
  }

  private async apply(tokens: HandoffTokens): Promise<void> {
    this.tokens.set(tokens.accessToken, tokens.expiresIn);
    await saveRefreshToken(tokens.refreshToken);
    this.deps.onTokenChanged(this.tokens.expiresAt);
    // Display identity is fetched OFF the token path (fire-and-forget, bounded) so a slow /me never stalls.
    void fetchAccount(tokens.accessToken).then((account) => {
      this.account = account;
      this.deps.onStateChanged?.();
    });
  }

  /** Serialize all auth flows (login / switch / refresh) so they cannot interleave on the shared token. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.flowLock.then(fn, fn);
    this.flowLock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
