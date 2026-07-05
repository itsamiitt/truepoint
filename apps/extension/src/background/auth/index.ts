// AuthModule — the facade (doc 10 §6.1/§6.2). Owns the in-memory token, single-flight + serialized silent
// re-auth, interactive login, logout, and workspace/org switching. Primary model = SILENT RE-AUTH
// (ADR-0044): fresh access tokens come from re-running launchWebAuthFlow non-interactively; NO refresh
// token is ever held by the extension. The `lw_refresh` cookie stays first-party on the auth origin.
import { ENV } from "../../shared/env.ts";
import type { AccountDisplay, AuthState, OrgSummary } from "../../shared/messages.ts";
import { clearSession, getSession, setSession } from "../../shared/storage.ts";
import { fetchAccount } from "./account.ts";
import {
  buildLoginUrl,
  createPkcePair,
  extractCode,
  randomState,
  redirectUri,
  runAuthFlow,
} from "./pkceFlow.ts";
import { AuthError, exchangeCode } from "./silentAuth.ts";
import { TokenStore } from "./tokenStore.ts";

const REFRESH_SKEW_MS = 60_000;

export interface AuthDeps {
  /** The SW schedules/clears the `auth-refresh` alarm from the new expiry (null = clear). Doc 10 §4.3. */
  onTokenChanged(expiresAtMs: number | null): void;
  /** Fired when derived state changes off the token path (the async account lookup) so the SW re-broadcasts. */
  onStateChanged?(): void;
}

interface FlowHint {
  workspaceId?: string;
  tenantId?: string;
}

export class AuthModule {
  private readonly tokens = new TokenStore();
  private account: AccountDisplay | null = null;
  private reauthInFlight: Promise<boolean> | null = null;
  private flowLock: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: AuthDeps) {}

  /** On worker wake: if a prior session marker exists, attempt one silent re-auth. */
  async init(): Promise<void> {
    if (await getSession<boolean>("logged_in")) {
      await this.reauth();
    }
  }

  /** Used by ApiClient before every request; silently re-auths if the token is missing/near-expiry. */
  async getAccessToken(): Promise<string | null> {
    if (this.tokens.isFresh(REFRESH_SKEW_MS)) {
      return this.tokens.raw;
    }
    if (await this.reauth()) {
      return this.tokens.raw;
    }
    // Silent re-auth failed (e.g. a transient auth-service blip). We refresh early (at the 60s skew), so a
    // token that has not ACTUALLY expired yet is still usable; otherwise we are signed out.
    return this.tokens.raw && Date.now() < this.tokens.expiresAt ? this.tokens.raw : null;
  }

  /** Force a silent re-auth (ApiClient 401-retry + the alarm pre-refresh). True ONLY when a new token was
   *  minted — so the 401-retry never re-sends a stale token. */
  async refreshNow(): Promise<boolean> {
    return this.reauth();
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

  /** Interactive login (first time / after full logout). */
  async login(): Promise<AuthState> {
    try {
      await this.serialize(() => this.runFlow(true, "login"));
    } catch {
      // stay signed-out; caller re-reads getState()
    }
    return this.getState();
  }

  async logout(): Promise<AuthState> {
    // Best-effort server session clear: the cross-origin POST can't carry the SameSite=Strict cookie, so
    // navigate to the auth-origin logout in a launchWebAuthFlow context. Local clear is guaranteed.
    try {
      const url = `${ENV.authOrigin}/auth/logout?redirect_uri=${encodeURIComponent(redirectUri())}`;
      await runAuthFlow(url, false);
    } catch {
      // best-effort
    }
    this.tokens.clear();
    this.account = null;
    this.deps.onTokenChanged(null);
    await clearSession("logged_in");
    return this.getState();
  }

  /** Re-mint the token with a new workspace (doc 10 §2.6) — a silent re-auth carrying the selection,
   *  serialized so a concurrent plain reauth can't clobber the switched scope. */
  async switchWorkspace(workspaceId: string): Promise<AuthState> {
    try {
      await this.serialize(() => this.runFlow(false, "none", { workspaceId }));
    } catch {
      // keep current session on failure
    }
    return this.getState();
  }

  async switchOrg(tenantId: string): Promise<AuthState> {
    try {
      await this.serialize(() => this.runFlow(false, "none", { tenantId }));
    } catch {
      // keep current session on failure
    }
    return this.getState();
  }

  /** List the user's orgs. `/auth/orgs` is cookie-based (cross-origin from the extension); the extension
   *  reads it via a Bearer API mirror. TODO(net-new, doc 10 §7): GET /api/v1/orgs. */
  async listOrgs(): Promise<{ orgs: OrgSummary[]; activeTenantId: string | null }> {
    return { orgs: [], activeTenantId: this.tokens.tenantId };
  }

  /** Single-flight silent re-auth: concurrent callers share one in-flight attempt, itself serialized
   *  against login/switch so flows never interleave. Returns true only when a fresh token is available. */
  private reauth(): Promise<boolean> {
    if (this.reauthInFlight) {
      return this.reauthInFlight;
    }
    this.reauthInFlight = this.serialize(async () => {
      // A login/switch we queued behind may have just minted a fresh token — skip a redundant flow.
      if (this.tokens.isFresh(REFRESH_SKEW_MS)) {
        return;
      }
      await this.runFlow(false, "none");
    })
      .then(() => true)
      .catch(() => false)
      .finally(() => {
        this.reauthInFlight = null;
      });
    return this.reauthInFlight;
  }

  /** Serialize all auth flows (login / switch / reauth) so they cannot interleave on the shared token. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.flowLock.then(fn, fn);
    this.flowLock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async runFlow(
    interactive: boolean,
    prompt: "login" | "none",
    hint?: FlowHint,
  ): Promise<void> {
    const { verifier, challenge } = await createPkcePair();
    const state = randomState();

    // The verifier + state stay in this closure only (no storage round-trip is needed — launchWebAuthFlow
    // resolves in-process, unlike the web app's redirect-to-a-new-page flow).
    const url = buildLoginUrl({ challenge, state, prompt, ...hint });
    const redirect = await runAuthFlow(url, interactive);
    if (!redirect) {
      throw new AuthError(0, "auth_incomplete");
    }
    const { code } = extractCode(redirect, state);
    const resp = await exchangeCode(code, verifier, state);

    this.tokens.set(resp.accessToken, resp.expiresIn);
    await setSession("logged_in", true);
    this.deps.onTokenChanged(this.tokens.expiresAt);

    // Display identity is fetched OFF the token path (fire-and-forget, bounded by its own timeout) so a
    // slow/hung GET /me can never stall the token — the token is already live. State re-broadcasts when
    // the name resolves.
    void fetchAccount(resp.accessToken).then((account) => {
      this.account = account;
      this.deps.onStateChanged?.();
    });
  }
}
