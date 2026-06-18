// types.ts — view shapes for the Developer settings scope (API keys · OAuth apps · Webhooks · API docs, 12 §5).
// These follow the documented /tenants/me/api-keys + /webhooks contracts (09 §3.1, §10). The API-key/OAuth/webhook
// backends are M10/M11 and not built, so the api layer reports availability (available / null) and the panels
// degrade to empty/connect states rather than inventing data. No fabricated secrets, no fake keys.

// ── API keys ──────────────────────────────────────────────────────────────────────────────────────────────

/** A documented API-key scope (09 §4 — scopes gate endpoints). */
export type ApiKeyScope = "search:read" | "reveal:write" | "outreach:write" | "export:write";

/** A tenant-scoped API key (hashed + prefixed; the secret is shown once at create time only). */
export interface ApiKey {
  id: string;
  name: string;
  /** Non-secret display prefix, e.g. "tp_live_a1b2…". */
  prefix: string;
  scopes: ApiKeyScope[];
  /** ISO timestamp or null when never used. */
  lastUsedAt?: string | null;
  createdAt: string;
}

/** `available` is false when the api-keys route isn't built yet. */
export interface ApiKeysFeed {
  available: boolean;
  keys: ApiKey[];
}

/** Returned once on create/rotate — the full secret. Empty `secret` means the backend isn't wired (no fake key). */
export interface ApiKeySecret {
  ok: boolean;
  id?: string;
  /** The one-time plaintext secret. Present only when the backend actually issued a key. */
  secret?: string | null;
}

// ── OAuth apps ────────────────────────────────────────────────────────────────────────────────────────────

/** A registered OAuth client (redirect URIs must resolve on the auth origin — 12 §5, ADR-0016). */
export interface OAuthApp {
  id: string;
  name: string;
  clientId: string;
  redirectUris: string[];
  scopes: string[];
  createdAt: string;
}

export interface OAuthAppsFeed {
  available: boolean;
  apps: OAuthApp[];
}

/** Returned once on registration — the client id + one-time client secret. */
export interface OAuthAppCredentials {
  ok: boolean;
  clientId?: string;
  /** One-time plaintext client secret; null/absent when the backend isn't wired. */
  clientSecret?: string | null;
}

// ── Webhooks ──────────────────────────────────────────────────────────────────────────────────────────────

/** Outbound webhook event vocabulary (09 §10) — the slice exposes the four called out in 12 §5. */
export type WebhookEvent =
  | "reveal.completed"
  | "score.updated"
  | "outreach.status_changed"
  | "auth.event";

export interface Webhook {
  id: string;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  /** Non-secret display prefix of the signing secret, e.g. "whsec_a1b2…". */
  secretPrefix?: string;
  createdAt: string;
}

export interface WebhooksFeed {
  available: boolean;
  webhooks: Webhook[];
}

/** Result of a self-test ping or a delivery replay (POST /:id/test, /deliveries/:id/replay). */
export interface WebhookTestResult {
  ok: boolean;
  /** HTTP status the endpoint returned, or null when the request never completed. */
  status?: "succeeded" | "failed";
  responseCode?: number | null;
}

/** Returned once on subscribe — the signing secret used to verify payload signatures. */
export interface WebhookSecret {
  ok: boolean;
  id?: string;
  /** One-time plaintext signing secret; null/absent when the backend isn't wired. */
  signingSecret?: string | null;
}

/** A single delivery-log entry (09 §10 — delivery log + replay). One row per attempt (incl. self-tests). */
export interface WebhookDelivery {
  id: string;
  /** The subscription this attempt targeted (null when the subscription was later deleted). */
  webhookId?: string | null;
  /** Event type — a subscribed event, or a synthetic `webhook.test` for self-test pings. */
  event: string;
  /** HTTP status of the attempt, or null when the request never completed. */
  status?: number | null;
  outcome: "succeeded" | "failed" | "pending";
  createdAt: string;
}

export interface DeliveryFeed {
  available: boolean;
  deliveries: WebhookDelivery[];
}

// ── Static vocab (labels + selectable options) ───────────────────────────────────────────────────────────

export const SCOPE_OPTIONS: { value: ApiKeyScope; label: string; description: string }[] = [
  { value: "search:read", label: "search:read", description: "Search contacts and accounts" },
  { value: "reveal:write", label: "reveal:write", description: "Reveal contacts (spends credits)" },
  { value: "outreach:write", label: "outreach:write", description: "Enroll and send outreach" },
  { value: "export:write", label: "export:write", description: "Create export jobs" },
];

export const SCOPE_LABEL: Record<ApiKeyScope, string> = {
  "search:read": "search:read",
  "reveal:write": "reveal:write",
  "outreach:write": "outreach:write",
  "export:write": "export:write",
};

export const EVENT_OPTIONS: { value: WebhookEvent; label: string; description: string }[] = [
  { value: "reveal.completed", label: "reveal.completed", description: "A reveal commits" },
  {
    value: "score.updated",
    label: "score.updated",
    description: "A contact's priority score changes",
  },
  {
    value: "outreach.status_changed",
    label: "outreach.status_changed",
    description: "An enrollment or contact outreach status changes",
  },
  { value: "auth.event", label: "auth.event", description: "An auth event of interest fires" },
];

export const EVENT_LABEL: Record<WebhookEvent, string> = {
  "reveal.completed": "reveal.completed",
  "score.updated": "score.updated",
  "outreach.status_changed": "outreach.status_changed",
  "auth.event": "auth.event",
};

export const DELIVERY_TONE: Record<WebhookDelivery["outcome"], "success" | "danger" | "warning"> = {
  succeeded: "success",
  failed: "danger",
  pending: "warning",
};

export const DELIVERY_LABEL: Record<WebhookDelivery["outcome"], string> = {
  succeeded: "Succeeded",
  failed: "Failed",
  pending: "Pending",
};
