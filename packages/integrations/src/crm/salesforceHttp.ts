// salesforceHttp.ts — the Salesforce error-taxonomy + rate-limit helpers (crm-sync §5.1 / §8.2). The
// generic transport (`defaultCrmFetch`), the form encoder, the case-insensitive `header` lookup, and the
// `CrmOAuthError` are SHARED with the HubSpot adapter (re-imported from ./hubspotHttp.ts — they are not
// vendor-specific). Only the SFDC-specific bits live here: `classifySalesforceStatus` maps SFDC's status +
// `[{ errorCode }]` body onto core's CrmOutcome variants, and `parseSalesforceLimits` reads the
// `Sforce-Limit-Info` daily-API-cap header. No new dependency — global fetch only (via hubspotHttp).

import type { CrmLimitSignal } from "@leadwolf/core";
import { type CrmErrorOutcome, header } from "./hubspotHttp.ts";

/** SFDC error bodies are arrays of `{ errorCode, message }` — read the first code (PII-free). */
function salesforceErrorCode(body: unknown): string | undefined {
  if (Array.isArray(body) && body.length > 0) {
    const first = (body[0] ?? {}) as { errorCode?: unknown };
    if (typeof first.errorCode === "string") return first.errorCode;
  }
  return undefined;
}

/**
 * Read SFDC's rate-limit telemetry. `Sforce-Limit-Info: api-usage=USED/MAX` is the per-org daily REST
 * cap (§5.4); `Retry-After` (seconds) appears on a throttled response. Remaining = MAX − USED (floored 0).
 */
export function parseSalesforceLimits(
  _status: number,
  headers: Record<string, string>,
  _body: unknown,
): CrmLimitSignal {
  let dailyMax: number | undefined;
  let dailyRemaining: number | undefined;
  const info = header(headers, "sforce-limit-info");
  const usage = info ? /api-usage=(\d+)\/(\d+)/.exec(info) : null;
  if (usage) {
    const used = Number(usage[1]);
    const max = Number(usage[2]);
    dailyMax = max;
    dailyRemaining = Math.max(0, max - used);
  }
  const retryAfter = header(headers, "retry-after");
  return {
    retryAfterMs: retryAfter ? Number(retryAfter) * 1000 : undefined,
    dailyRemaining,
    dailyMax,
  };
}

/**
 * Map a non-2xx SFDC response onto a CrmOutcome error variant (null for a 2xx). 429 / REQUEST_LIMIT_EXCEEDED
 * → rate_limited (daily); 401 / INVALID_SESSION_ID → auth_expired (one refresh+retry); 404 → not_found;
 * 300 (ambiguous external-id) / DUPLICATE_VALUE → conflict; 400/422 → validation (no retry); 5xx → transient;
 * everything else (incl. a 403 INSUFFICIENT_ACCESS) → permanent — which the erase fallback treats as "may
 * not hard-delete → anonymize" (§7.6).
 */
export function classifySalesforceStatus(
  status: number,
  headers: Record<string, string>,
  body: unknown,
): CrmErrorOutcome | null {
  if (status >= 200 && status < 300) return null;
  const code = salesforceErrorCode(body);
  if (status === 429 || code === "REQUEST_LIMIT_EXCEEDED") {
    const limits = parseSalesforceLimits(status, headers, body);
    return {
      kind: "rate_limited",
      retryAfterMs: limits.retryAfterMs ?? 60_000,
      daily: code === "REQUEST_LIMIT_EXCEEDED" || limits.dailyRemaining === 0,
    };
  }
  if (status === 401 || code === "INVALID_SESSION_ID") return { kind: "auth_expired" };
  if (status === 404 || code === "NOT_FOUND") return { kind: "not_found" };
  if (status === 300 || code === "DUPLICATE_VALUE" || code === "DUPLICATES_DETECTED") {
    return { kind: "conflict", detail: body };
  }
  if (status === 400 || status === 422) return { kind: "validation", detail: body };
  if (status >= 500) return { kind: "transient", status };
  return { kind: "permanent", status, detail: body };
}
