// cors.ts — CORS for the token endpoints: echo the request Origin ONLY when it is an allow-listed app
// origin (never a wildcard), with credentials. Used by /token/exchange and /token/refresh (ADR-0016).
import { isAllowedOrigin } from "@leadwolf/config";

export function corsHeaders(origin: string | null): Record<string, string> {
  if (!isAllowedOrigin(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin as string,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    Vary: "Origin",
  };
}
