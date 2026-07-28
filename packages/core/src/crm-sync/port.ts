// port.ts — the provider-agnostic CRM connector contract (crm-sync §5.1). core OWNS the port; the concrete
// adapters in packages/integrations (hubspot now, salesforce next) IMPLEMENT it (16 §5 direction:
// integrations → core). The engine never knows which CRM answered — only this contract. Transport is the
// injectable `CrmFetch` (the FetchJson analog) so contract tests run on RECORDED fixtures with ZERO live
// spend. Closed enums (CrmProvider/CrmObjectType/CrmEnvironment) live in @leadwolf/types — the shared
// producer/consumer contract — and are imported here, never re-declared.

import type { CrmEnvironment, CrmObjectType, CrmProvider } from "@leadwolf/types";

/** Decrypted, SERVER-ONLY token bundle — lives encrypted in `crm_connections.oauth_token_enc`, never in a DTO. */
export interface CrmTokenBundle {
  accessToken: string;
  /** Absent for SFDC JWT-bearer / HubSpot private-app static tokens. */
  refreshToken?: string;
  /** epoch ms; 0 = a non-expiring static token. Computed from `expires_in` at exchange time. */
  expiresAt: number;
  scopes: string[];
  /** SFDC org host (the API base). Null for HubSpot. */
  instanceUrl?: string;
  /** HubSpot API base / non-secret org id. */
  apiBaseUrl?: string;
  externalAccountId?: string;
  environment: CrmEnvironment;
}

/** The injectable HTTP transport: one request → status + headers + parsed JSON. Tests substitute a fixture. */
export type CrmFetch = (req: {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}) => Promise<{ status: number; headers: Record<string, string>; json: unknown }>;

/** Rate-limit telemetry parsed off a response (drives the §8.2 budget + backoff). */
export interface CrmLimitSignal {
  retryAfterMs?: number;
  dailyRemaining?: number;
  dailyMax?: number;
}

/**
 * The outcome of a connector call. Richer than the enrichment adapter's 429/≥400 split: refresh-retry,
 * daily-cap, and do-not-retry classes drive different control flow in the runner (§5.1).
 */
export type CrmOutcome<T> =
  | { kind: "ok"; value: T; limits: CrmLimitSignal }
  | { kind: "rate_limited"; retryAfterMs: number; daily: boolean } // 429 / REQUEST_LIMIT_EXCEEDED
  | { kind: "auth_expired" } // 401 / INVALID_SESSION_ID → exactly ONE refresh+retry
  | { kind: "auth_revoked" } // invalid_grant on refresh → connection.status='error'
  | { kind: "not_found" }
  | { kind: "validation"; detail: unknown } // 400/422 — DO NOT retry
  | { kind: "conflict"; detail: unknown } // 409 / DUPLICATE_VALUE
  | { kind: "transient"; status: number } // 5xx / network — retry w/ backoff
  | { kind: "permanent"; status: number; detail: unknown };

/** What `testConnection` reports — the connected account + the daily-cap probe. */
export interface CrmAccountInfo {
  account: string;
  environment: CrmEnvironment;
  daily?: { used: number; max: number };
}

/** One pre-mapped record to upsert: the TP UUID external key + the CRM-field → value payload. */
export interface CrmUpsertRecord {
  externalId: string;
  values: Record<string, unknown>;
}

/** Per-record upsert outcome (HubSpot/SFDC batch responses report per row). */
export interface CrmUpsertResult {
  externalId: string;
  outcome: "created" | "updated" | "rejected";
  detail?: unknown;
}

/** One parsed inbound change hint (the webhook payload is a lossy delta → the worker re-fetches). */
export interface CrmWebhookEvent {
  object: CrmObjectType;
  externalId: string;
  eventId: string;
  sourceTag: string;
}

/** How an outward erasure is satisfied per provider (DSAR propagation, §7.6). */
export type CrmEraseMode = "delete" | "gdpr_delete" | "anonymize";

/** Which erasure path the provider could actually satisfy — the §7.6 erased-vs-anonymized proof. */
export type CrmErasePath = "deleted" | "gdpr_deleted" | "anonymized";

/**
 * The explicit result of `eraseOrSuppress` — the connector NEVER silently no-ops an erasure: an `ok`
 * outcome always names the path taken (so the DSAR `scope_report` records erased-vs-anonymized, §7.6).
 */
export interface CrmEraseResult {
  path: CrmErasePath;
  /** Set when the path could not hard-delete and instead anonymized + flagged Do-Not-Contact. */
  doNotContact?: boolean;
}

/**
 * The CRM connector port. OAuth is server-side only; the data plane is upsert-by-external-key (the TP UUID)
 * so create-or-update is one idempotent call (§6.4). Every data-plane method takes an OPTIONAL `fetch` so a
 * caller can override the connector's default transport per call (contract tests pass a fixture).
 */
export interface CrmConnector {
  readonly provider: CrmProvider;
  /** false when client id/secret are absent — the adapter NEVER throws at construction (providers.ts posture). */
  readonly configured: boolean;

  // OAuth (server-side only) — see §5.2.
  buildAuthorizeUrl(a: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
    scopes: string[];
    env: CrmEnvironment;
  }): string;
  exchangeCode(
    a: { code: string; codeVerifier: string; redirectUri: string; env: CrmEnvironment },
    fetch?: CrmFetch,
  ): Promise<CrmTokenBundle>;
  /** Trade the refresh token for a fresh bundle; throws/returns auth_revoked path on invalid_grant. */
  refresh(bundle: CrmTokenBundle, fetch?: CrmFetch): Promise<CrmTokenBundle>;
  testConnection(bundle: CrmTokenBundle, fetch?: CrmFetch): Promise<CrmOutcome<CrmAccountInfo>>;

  // Data plane.
  pullPage(
    a: { bundle: CrmTokenBundle; object: CrmObjectType; cursor?: string; pageSize: number },
    fetch?: CrmFetch,
  ): Promise<CrmOutcome<{ records: unknown[]; nextCursor?: string; highWatermark?: string }>>;
  pullDelta(
    a: { bundle: CrmTokenBundle; object: CrmObjectType; sinceWatermark: string; pageSize: number },
    fetch?: CrmFetch,
  ): Promise<CrmOutcome<{ records: unknown[]; highWatermark: string }>>;
  fetchOne(
    a: { bundle: CrmTokenBundle; object: CrmObjectType; externalId: string },
    fetch?: CrmFetch,
  ): Promise<CrmOutcome<{ record: unknown | null }>>;
  upsert(
    a: {
      bundle: CrmTokenBundle;
      object: CrmObjectType;
      externalIdField: string;
      records: CrmUpsertRecord[];
    },
    fetch?: CrmFetch,
  ): Promise<CrmOutcome<{ perRecord: CrmUpsertResult[] }>>;
  eraseOrSuppress(
    a: { bundle: CrmTokenBundle; object: CrmObjectType; externalId: string; mode: CrmEraseMode },
    fetch?: CrmFetch,
  ): Promise<CrmOutcome<CrmEraseResult>>;

  // Inbound trust boundary.
  verifyWebhook(raw: string, headers: Record<string, string>, secret: string): boolean;
  parseWebhookEnvelope(raw: string): CrmWebhookEvent[];
  parseLimits(status: number, headers: Record<string, string>, body: unknown): CrmLimitSignal;
}
