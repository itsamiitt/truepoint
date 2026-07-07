// extensionScope.ts — AUTH-065. An extension-scoped access token (scope:["extension"], aud=chrome-extension://<id>,
// minted by /auth/extension/mint) is a NARROW prospecting credential — the Chrome companion only ingests captures,
// reveals contacts, and reads credit balances. But apps/api verified only the token's signature + audience and
// never its SCOPE, so an exfiltrated extension token could call the ENTIRE tenant API (imports, billing, exports,
// admin…). This restricts an extension token to an explicit allow-list of the routes the extension actually uses,
// deny-by-default. Web/admin tokens carry scope:[] (see the /token/exchange mint) and are never touched.
//
// ROLLOUT is lockout-safe (doc 09/12): a wrong allow-list would 403 the LIVE extension, so the guard defaults to
// OBSERVE — an out-of-allow-list call is logged with a stable marker but ALLOWED — until the allow-list is
// validated against real traffic. env.EXTENSION_SCOPE_ENFORCE="true" flips it to deny (403 insufficient_scope);
// that is a config change, not a redeploy, and only affects extension-scoped tokens. See authn.ts for the wiring.
//
// This module is PURE (no env, no Redis, no Hono) so the allow-list and the discriminator are unit-testable; the
// observe-vs-enforce decision + logging live at the authn call site.

import type { AccessTokenClaims } from "@leadwolf/types";

/** The scope string a /auth/extension/mint token carries; the portable discriminator (always present in claims). */
export const EXTENSION_SCOPE = "extension";

/** True iff this is an extension-minted token. Web/admin tokens carry scope:[] → false (never restricted). */
export function isExtensionToken(claims: Pick<AccessTokenClaims, "scope">): boolean {
  return claims.scope.includes(EXTENSION_SCOPE);
}

interface RouteRule {
  method: string;
  pattern: RegExp;
}

// `:id`-style placeholders match exactly one non-slash segment (a resource id). Anchored + optional trailing
// slash → an exact route match, never a prefix (so /ingest can't authorize /ingest/../admin).
const rule = (method: string, path: string): RouteRule => ({
  method,
  pattern: new RegExp(`^${path.replace(/:[a-zA-Z]+/g, "[^/]+")}/?$`),
});

// The routes the Chrome extension actually calls (paths as apps/api sees them, under /api/v1) — derived from
// apps/extension/src/background (api/client.ts + auth/*): ingest a capture, reveal a captured contact, read
// credit balance/costs, and the identity/org bootstrap. Method-aware, so an extension token can POST its own
// ingest/reveal but not issue arbitrary writes. EXTEND THIS DELIBERATELY when the extension gains a surface —
// that review is the deny-by-default control working as intended, not friction to route around.
const EXTENSION_ALLOW_LIST: readonly RouteRule[] = [
  rule("POST", "/api/v1/ingest"),
  rule("POST", "/api/v1/contacts/:id/reveal"),
  rule("GET", "/api/v1/contacts/:id"),
  rule("GET", "/api/v1/credits/balance"),
  rule("GET", "/api/v1/credits/reveal-costs"),
  rule("GET", "/api/v1/me"),
  rule("GET", "/api/v1/orgs"),
];

/** Drop a query string, keeping just the path (split always yields ≥1 element; `?? path` satisfies the strict
 *  noUncheckedIndexedAccess compiler config). */
const stripQuery = (path: string): string => path.split("?")[0] ?? path;

/** Is `method path` on the extension allow-list? Pure + method-aware; the caller decides observe vs enforce.
 *  A query string on `path` is ignored (matched against the path only). */
export function extensionRouteAllowed(method: string, path: string): boolean {
  const m = method.toUpperCase();
  const p = stripQuery(path);
  return EXTENSION_ALLOW_LIST.some((r) => r.method === m && r.pattern.test(p));
}

/** Stable, PII-free marker for an extension token stepping outside its allow-list. Alert on "[authz] extension-scope".
 *  Logs only the method + request path (ids in a path are not PII; the query string is stripped) — never the token. */
export function extensionScopeViolationLog(
  method: string,
  path: string,
  mode: "observed" | "denied",
): string {
  return `[authz] extension-scope ${mode} method=${method.toUpperCase()} path=${stripQuery(path)} — scope=[extension] outside prospecting allow-list`;
}
