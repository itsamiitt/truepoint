// hubspotHttp.ts — the transport + error-taxonomy helpers shared by the HubSpot connector (crm-sync §5.1 /
// §8.2). `defaultCrmFetch` is the production CrmFetch over global fetch (JSON or pre-encoded string body);
// tests inject a fixture instead, so the connector runs with ZERO live spend (the httpProvider.ts:14 idiom).
// `classifyHubspotStatus` maps an HTTP status onto core's CrmOutcome error variants so the runner can drive
// refresh-retry / backoff / do-not-retry; `parseHubspotLimits` reads HubSpot's rate-limit headers.

import type { CrmFetch, CrmLimitSignal, CrmOutcome } from "@leadwolf/core";

/** The non-ok CrmOutcome variants — none reference the value type, so they are reusable across object kinds. */
export type CrmErrorOutcome = Exclude<CrmOutcome<unknown>, { kind: "ok" }>;

/** A token-endpoint failure (OAuth exchange/refresh). Carries ONLY the error code — never a token or secret. */
export class CrmOAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CrmOAuthError";
  }
}

/** Encode a request body: pass a string through (form-encoded token endpoint), JSON.stringify anything else. */
function encodeBody(body: unknown): string | undefined {
  if (body === undefined) return undefined;
  if (typeof body === "string") return body;
  return JSON.stringify(body);
}

/** Default transport: JSON unless the body is already a string (the form-encoded token endpoint). */
export const defaultCrmFetch: CrmFetch = async ({ method, url, headers, body }) => {
  const res = await fetch(url, { method, headers, body: encodeBody(body) });
  const json = await res.json().catch(() => null);
  const outHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    outHeaders[k.toLowerCase()] = v;
  });
  return { status: res.status, headers: outHeaders, json };
};

/** Case-insensitive header lookup (CrmFetch may return mixed-case keys from the network). */
export function header(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** Read HubSpot's rate-limit telemetry: `Retry-After` (s) + the daily-remaining/daily headers (§5.4). */
export function parseHubspotLimits(
  _status: number,
  headers: Record<string, string>,
  _body: unknown,
): CrmLimitSignal {
  const retryAfter = header(headers, "retry-after");
  const dailyRemaining = header(headers, "x-hubspot-ratelimit-daily-remaining");
  const dailyMax = header(headers, "x-hubspot-ratelimit-daily");
  return {
    retryAfterMs: retryAfter ? Number(retryAfter) * 1000 : undefined,
    dailyRemaining: dailyRemaining ? Number(dailyRemaining) : undefined,
    dailyMax: dailyMax ? Number(dailyMax) : undefined,
  };
}

/**
 * Map a non-2xx HTTP status onto a CrmOutcome error variant (null for a 2xx). 429 → rate_limited (daily when
 * the remaining header is 0); 401 → auth_expired (one refresh+retry); 400/422 → validation (no retry);
 * 409 → conflict; 404 → not_found; 5xx → transient (backoff); anything else → permanent.
 */
export function classifyHubspotStatus(
  status: number,
  headers: Record<string, string>,
  body: unknown,
): CrmErrorOutcome | null {
  if (status >= 200 && status < 300) return null;
  if (status === 429) {
    const limits = parseHubspotLimits(status, headers, body);
    return {
      kind: "rate_limited",
      retryAfterMs: limits.retryAfterMs ?? 10_000,
      daily: limits.dailyRemaining === 0,
    };
  }
  if (status === 401) return { kind: "auth_expired" };
  if (status === 404) return { kind: "not_found" };
  if (status === 400 || status === 422) return { kind: "validation", detail: body };
  if (status === 409) return { kind: "conflict", detail: body };
  if (status >= 500) return { kind: "transient", status };
  return { kind: "permanent", status, detail: body };
}

/** Form-encode an OAuth token-endpoint body (the only non-JSON HubSpot payload). */
export function formEncode(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}
