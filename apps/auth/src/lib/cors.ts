// cors.ts — CORS for the token endpoints: echo the request Origin ONLY when it is an allow-listed app
// origin (never a wildcard), with credentials. Used by /token/exchange and /token/refresh (ADR-0016).
import { isAllowedOrigin } from "@leadwolf/config";

// How long (seconds) the browser may cache the CORS preflight for these credentialed token endpoints.
// Without it, every sign-in re-runs an OPTIONS round-trip before each /token/* POST (perf RC#5). 10 min is
// well under Chromium's 2-hour cap and keeps the allow-list/credentials policy fresh after a config change.
const PREFLIGHT_MAX_AGE = 600;

export function corsHeaders(origin: string | null): Record<string, string> {
  if (!isAllowedOrigin(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin as string,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": String(PREFLIGHT_MAX_AGE),
    Vary: "Origin",
  };
}
