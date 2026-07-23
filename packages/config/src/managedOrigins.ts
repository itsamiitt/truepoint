// managedOrigins.ts — AUTH-036 (doc 08 §3, doc 12 Phase 1): the effective callback/redirect-origin allow-list is
// the env FLOOR (APP_ORIGINS ∪ EXTENSION_ORIGINS — the platform's own origins, which must ALWAYS resolve) unioned
// with the per-tenant MANAGED origins stored in `auth_allowed_origins`. Managed config can only ADD an origin; it
// can never remove an env-floor origin, so a misconfigured or emptied managed set can never lock the app out of
// its own callbacks (fail-safe). Exact-match membership mirrors the existing isAllowedOrigin — an open-redirect
// guard NEVER prefix/substring-matches a redirect target. Pure: the caller supplies both lists (env from
// @leadwolf/config, managed from the DB), so this is unit-testable without env or a database.

/** The effective allow-list: env floor first (always allowed), then the managed origins — deduped, stable order. */
export function resolveAllowedOrigins(
  envFloor: readonly string[],
  managed: readonly string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const origin of [...envFloor, ...managed]) {
    if (!seen.has(origin)) {
      seen.add(origin);
      out.push(origin);
    }
  }
  return out;
}

/** True iff `origin` is in the env floor OR the managed set — EXACT match. A null/undefined origin is never
 *  allowed. The floor is checked first so the platform's own origins always resolve, whatever managed config holds. */
export function isOriginAllowed(
  origin: string | null | undefined,
  envFloor: readonly string[],
  managed: readonly string[],
): boolean {
  if (origin == null) return false;
  return envFloor.includes(origin) || managed.includes(origin);
}

/**
 * Validate + CANONICALISE a managed origin before it is stored (the write-path guard for AUTH-036). Returns the
 * canonical origin (`scheme://host[:port]`, no trailing slash) when the input is a bare **https** origin, else
 * null. Rejects everything that could turn a stored allow-list entry into an open-redirect / token-exfiltration
 * target: non-https schemes, embedded credentials, any path/query/fragment, and wildcard hosts. Because storage
 * is canonical and resolution is exact-match, only this precise origin is ever accepted at redirect time.
 */
export function canonicalManagedOrigin(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return null; // not a URL at all
  }
  if (u.protocol !== "https:") return null; // callbacks must be https (no http/data/javascript/etc.)
  if (u.username || u.password) return null; // no embedded credentials
  if (u.pathname !== "/" && u.pathname !== "") return null; // an ORIGIN, not a full URL — no path
  if (u.search || u.hash) return null; // no query/fragment
  if (u.hostname.includes("*")) return null; // no wildcard hosts
  return u.origin; // canonical: scheme://host[:port], no trailing slash
}
