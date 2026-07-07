// TokenStore — the in-memory access token + decoded claims (doc 10 §6.2). Nothing here is persisted:
// the access token lives only as long as the service worker, by design (ADR-0044 / 03 §1.4).
// Claims match the REAL server contract (packages/types/src/auth.ts): sub·tid·wid·sid·scope·pa·exp —
// there is NO email/account and NO roles claim (roles are per-request server-side).

export interface AccessClaims {
  sub: string;
  tid: string;
  wid: string | null;
  sid: string;
  scope: string[];
  pa: boolean;
  /** Expiry in seconds since epoch (JWT `exp`). */
  exp: number;
}

export class TokenStore {
  private token: string | null = null;
  private claims: AccessClaims | null = null;
  private expiresAtMs = 0;

  /** Store a freshly-minted token. `expiresInSeconds` (from the token response) is a defensive floor. */
  set(token: string, expiresInSeconds?: number): void {
    this.token = token;
    this.claims = decodeClaims(token);
    const fromClaim = (this.claims?.exp ?? 0) * 1000;
    const fromResp = expiresInSeconds ? Date.now() + expiresInSeconds * 1000 : 0;
    this.expiresAtMs =
      fromClaim && fromResp ? Math.min(fromClaim, fromResp) : fromClaim || fromResp;
  }

  clear(): void {
    this.token = null;
    this.claims = null;
    this.expiresAtMs = 0;
  }

  get raw(): string | null {
    return this.token;
  }

  get tenantId(): string | null {
    return this.claims?.tid ?? null;
  }

  get workspaceId(): string | null {
    return this.claims?.wid ?? null;
  }

  /** The revocation-denylist key (server checks `revoked-sid:<sid>`). */
  get sessionId(): string | null {
    return this.claims?.sid ?? null;
  }

  get expiresAt(): number {
    return this.expiresAtMs;
  }

  /** Fresh = present and more than `skewMs` before expiry. */
  isFresh(skewMs: number): boolean {
    return this.token !== null && Date.now() < this.expiresAtMs - skewMs;
  }
}

function decodeClaims(token: string): AccessClaims | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) {
      return null;
    }
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const data = JSON.parse(json) as Record<string, unknown>;
    if (
      typeof data.sub !== "string" ||
      typeof data.tid !== "string" ||
      typeof data.sid !== "string"
    ) {
      return null;
    }
    return {
      sub: data.sub,
      tid: data.tid,
      wid: typeof data.wid === "string" ? data.wid : null,
      sid: data.sid,
      scope: Array.isArray(data.scope)
        ? data.scope.filter((s): s is string => typeof s === "string")
        : [],
      pa: data.pa === true,
      exp: typeof data.exp === "number" ? data.exp : 0,
    };
  } catch {
    return null;
  }
}
