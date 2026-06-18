// api.ts — the Developer-settings backend seam: authenticated calls (fetchWithAuth, ADR-0016) to the documented
// /tenants/me/api-keys + /webhooks routes (09 §3.1, §10; 12 §5). These backends are M10/M11 and don't exist yet,
// so a 404/501 is treated as "not built" — surfaced as available:false / ok:false so the panels render
// empty/connect states instead of errors. No fabricated keys, no fake secrets, no fake mutations.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type {
  ApiKey,
  ApiKeyScope,
  ApiKeySecret,
  ApiKeysFeed,
  DeliveryFeed,
  OAuthApp,
  OAuthAppCredentials,
  OAuthAppsFeed,
  Webhook,
  WebhookDelivery,
  WebhookEvent,
  WebhookSecret,
  WebhookTestResult,
  WebhooksFeed,
} from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** A route that isn't built yet answers 404/501 — that's "nothing here", not a failure to surface. */
function notBuilt(status: number): boolean {
  return status === 404 || status === 501;
}

const API_KEYS = `${API_BASE}/api/v1/tenants/me/api-keys`;
const OAUTH_APPS = `${API_BASE}/api/v1/tenants/me/oauth-apps`;
const WEBHOOKS = `${API_BASE}/api/v1/webhooks`;

// ── API keys (09 §3.1 — /tenants/me/api-keys create/list/revoke) ───────────────────────────────────────────

export async function fetchApiKeys(): Promise<ApiKeysFeed> {
  const res = await fetchWithAuth(API_KEYS);
  if (notBuilt(res.status)) return { available: false, keys: [] };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load API keys"));
  const body = (await res.json()) as { keys?: ApiKey[] };
  return { available: true, keys: body.keys ?? [] };
}

export async function createApiKey(name: string, scopes: ApiKeyScope[]): Promise<ApiKeySecret> {
  const res = await fetchWithAuth(API_KEYS, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, scopes }),
  });
  if (notBuilt(res.status)) return { ok: false };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not create the API key"));
  const body = (await res.json()) as { id?: string; secret?: string };
  return { ok: true, id: body.id, secret: body.secret ?? null };
}

export async function rotateApiKey(id: string): Promise<ApiKeySecret> {
  const res = await fetchWithAuth(`${API_KEYS}/${id}/rotate`, { method: "POST" });
  if (notBuilt(res.status)) return { ok: false };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not rotate the API key"));
  const body = (await res.json()) as { id?: string; secret?: string };
  return { ok: true, id: body.id ?? id, secret: body.secret ?? null };
}

export async function revokeApiKey(id: string): Promise<{ ok: boolean }> {
  const res = await fetchWithAuth(`${API_KEYS}/${id}`, { method: "DELETE" });
  if (notBuilt(res.status)) return { ok: false };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not revoke the API key"));
  return { ok: true };
}

// ── OAuth apps (12 §5 — register oauth_app_clients; redirect URIs on the auth origin) ──────────────────────

export async function fetchOAuthApps(): Promise<OAuthAppsFeed> {
  const res = await fetchWithAuth(OAUTH_APPS);
  if (notBuilt(res.status)) return { available: false, apps: [] };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load OAuth apps"));
  const body = (await res.json()) as { apps?: OAuthApp[] };
  return { available: true, apps: body.apps ?? [] };
}

export async function registerOAuthApp(
  name: string,
  redirectUris: string[],
): Promise<OAuthAppCredentials> {
  const res = await fetchWithAuth(OAUTH_APPS, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, redirectUris }),
  });
  if (notBuilt(res.status)) return { ok: false };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not register the OAuth app"));
  const body = (await res.json()) as { clientId?: string; clientSecret?: string };
  return { ok: true, clientId: body.clientId, clientSecret: body.clientSecret ?? null };
}

export async function deleteOAuthApp(id: string): Promise<{ ok: boolean }> {
  const res = await fetchWithAuth(`${OAUTH_APPS}/${id}`, { method: "DELETE" });
  if (notBuilt(res.status)) return { ok: false };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not remove the OAuth app"));
  return { ok: true };
}

// ── Webhooks (09 §10, §3.1 — /webhooks CRUD subscriptions + delivery log) ──────────────────────────────────

export async function fetchWebhooks(): Promise<WebhooksFeed> {
  const res = await fetchWithAuth(WEBHOOKS);
  if (notBuilt(res.status)) return { available: false, webhooks: [] };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load webhooks"));
  const body = (await res.json()) as { webhooks?: Webhook[] };
  return { available: true, webhooks: body.webhooks ?? [] };
}

export async function createWebhook(url: string, events: WebhookEvent[]): Promise<WebhookSecret> {
  const res = await fetchWithAuth(WEBHOOKS, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, events }),
  });
  if (notBuilt(res.status)) return { ok: false };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not create the webhook"));
  const body = (await res.json()) as { id?: string; signingSecret?: string };
  return { ok: true, id: body.id, signingSecret: body.signingSecret ?? null };
}

export async function deleteWebhook(id: string): Promise<{ ok: boolean }> {
  const res = await fetchWithAuth(`${WEBHOOKS}/${id}`, { method: "DELETE" });
  if (notBuilt(res.status)) return { ok: false };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not remove the webhook"));
  return { ok: true };
}

/** The server's per-attempt delivery row (status = outcome, responseCode = HTTP, attemptedAt = when). */
interface DeliveryWire {
  id: string;
  webhookId?: string | null;
  event: string;
  status: "succeeded" | "failed" | "pending";
  responseCode?: number | null;
  attemptedAt: string;
}

export async function fetchDeliveries(): Promise<DeliveryFeed> {
  const res = await fetchWithAuth(`${WEBHOOKS}/deliveries`);
  if (notBuilt(res.status)) return { available: false, deliveries: [] };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load the delivery log"));
  const body = (await res.json()) as { deliveries?: DeliveryWire[] };
  const deliveries: WebhookDelivery[] = (body.deliveries ?? []).map((d) => ({
    id: d.id,
    webhookId: d.webhookId ?? null,
    event: d.event,
    outcome: d.status,
    status: d.responseCode ?? null,
    createdAt: d.attemptedAt,
  }));
  return { available: true, deliveries };
}

/** Fire a self-test ping at a subscription (POST /webhooks/:id/test). */
export async function testWebhook(id: string): Promise<WebhookTestResult> {
  const res = await fetchWithAuth(`${WEBHOOKS}/${id}/test`, { method: "POST" });
  if (notBuilt(res.status)) return { ok: false };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not send the test event"));
  const body = (await res.json()) as {
    status?: "succeeded" | "failed";
    responseCode?: number | null;
  };
  return { ok: true, status: body.status, responseCode: body.responseCode ?? null };
}

/** Re-POST a past delivery with a freshly computed signature (POST /webhooks/deliveries/:id/replay). */
export async function replayDelivery(id: string): Promise<WebhookTestResult> {
  const res = await fetchWithAuth(`${WEBHOOKS}/deliveries/${id}/replay`, { method: "POST" });
  if (notBuilt(res.status)) return { ok: false };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not replay the delivery"));
  const body = (await res.json()) as {
    status?: "succeeded" | "failed";
    responseCode?: number | null;
  };
  return { ok: true, status: body.status, responseCode: body.responseCode ?? null };
}
