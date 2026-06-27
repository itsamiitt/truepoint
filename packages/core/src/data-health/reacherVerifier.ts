// reacherVerifier.ts — the email-verification adapter for Reacher (the self-hostable / hosted
// check-if-email-exists engine, reacher.email) implementing core's EmailVerifierPort (06 §9, 01 §5.2).
// Reacher runs an SMTP RCPT-TO probe (it never sends mail) and returns `is_reachable` + `smtp.*` booleans;
// we map that onto our EmailStatus. The HTTP call is INJECTABLE (`fetchJson`) so tests run on recorded
// fixtures with zero network — exactly the pattern the enrichment httpProvider uses. The backend URL + token
// come from config (the token is a SECRET for the hosted API; absent backend → the factory returns
// passThroughVerifier, preserving today's no-grading behaviour). A transport error NEVER throws — it returns
// the stored status (the verifier "didn't run"), so a Reacher outage can never fail the reveal path
// (revealContact verifies OUTSIDE the charging tx, 14 §3.5).

import { env } from "@leadwolf/config";
import type { EmailStatus } from "@leadwolf/types";
import { type EmailVerifierPort, passThroughVerifier } from "./emailVerifier.ts";

/** Injectable POST→JSON (mirrors integrations/httpProvider FetchJson) so the adapter is testable offline. */
export type VerifierFetch = (
  url: string,
  init: { headers: Record<string, string>; body: unknown },
) => Promise<{ status: number; json: unknown }>;

const defaultVerifierFetch: VerifierFetch = async (url, init) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...init.headers },
    body: JSON.stringify(init.body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

/**
 * Map a Reacher `check_email` response onto an EmailStatus. `safe`→`valid`, `invalid`→`invalid`,
 * `risky`→`catch_all` when the domain is accept-all else `risky`, `unknown`→`unknown` (provider blocked the
 * probe — a real determination, charged 0 by chargeFor). An unparseable / missing `is_reachable` returns
 * `currentStatus` (no information → no change).
 */
export function reacherStatusFrom(json: unknown, currentStatus: EmailStatus): EmailStatus {
  if (typeof json !== "object" || json === null) return currentStatus;
  const obj = json as Record<string, unknown>;
  const smtp = (
    typeof obj.smtp === "object" && obj.smtp !== null ? obj.smtp : {}
  ) as Record<string, unknown>;
  switch (obj.is_reachable) {
    case "safe":
      return "valid";
    case "invalid":
      return "invalid";
    case "risky":
      return smtp.is_catch_all === true ? "catch_all" : "risky";
    case "unknown":
      return "unknown";
    default:
      return currentStatus;
  }
}

export interface ReacherVerifierOptions {
  /** Base origin of the Reacher backend (self-host) or hosted API (https://api.reacher.email). */
  backendUrl: string;
  /** Bearer token for the hosted Reacher API (a SECRET). Omit for an unauthenticated self-host backend. */
  apiToken?: string | undefined;
  /** Injected for tests; defaults to a real `fetch` POST. */
  fetchJson?: VerifierFetch | undefined;
}

/**
 * A verifier backed by Reacher's `POST {backendUrl}/v0/check_email`. A non-2xx response or a transport
 * throw degrades to the caller's stored status (the verifier "didn't run") — it never throws, so a Reacher
 * outage cannot fail a reveal.
 */
export function reacherVerifier(opts: ReacherVerifierOptions): EmailVerifierPort {
  const fetchJson = opts.fetchJson ?? defaultVerifierFetch;
  const url = `${opts.backendUrl.replace(/\/+$/, "")}/v0/check_email`;
  const headers: Record<string, string> = opts.apiToken
    ? { authorization: `Bearer ${opts.apiToken}` }
    : {};
  return {
    name: "reacher",
    async verify(email: string, currentStatus: EmailStatus): Promise<EmailStatus> {
      try {
        const { status, json } = await fetchJson(url, { headers, body: { to_email: email } });
        if (status < 200 || status >= 300) return currentStatus; // didn't run → no change
        return reacherStatusFrom(json, currentStatus);
      } catch {
        return currentStatus; // network/transport error → never fail the reveal; keep the stored status
      }
    },
  };
}

/**
 * The configured email verifier for the reveal/enrich paths (06 §9). When `REACHER_BACKEND_URL` is set,
 * grade via Reacher; otherwise keep today's `passThroughVerifier` (no vendor → no grading, the charge
 * policy's `unverified = full charge` baseline). The commercial secondary that resolves Reacher's
 * catch-all/unknown tail (01 §5.2) is an open vendor decision (03 §7) — when one is wired, compose it here
 * with `hybridVerifier(reacher, commercial)`; the seam (`hybridVerifier`) is ready.
 */
export function defaultEmailVerifier(fetchJson?: VerifierFetch): EmailVerifierPort {
  const backendUrl = env.REACHER_BACKEND_URL;
  if (!backendUrl) return passThroughVerifier;
  return reacherVerifier({ backendUrl, apiToken: env.REACHER_API_TOKEN, fetchJson });
}
