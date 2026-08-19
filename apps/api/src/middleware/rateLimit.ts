// rateLimit.ts — the UNAUTHENTICATED per-IP backstop for the resource API (mission §rate-limiting). Registered
// at the app root, which runs BEFORE every router's authn — so claims can never be present here. The old
// implementation read `c.get("claims")` anyway; that branch was dead code, and every authenticated caller fell
// through to the IP key, putting an entire office/VPN/NAT egress into ONE shared 120/min bucket. One team's
// normal browsing (a filter edit fans out to several search calls, job pollers tick underneath) exhausted it
// and produced intermittent fleet-wide 429s (perf-audit RC2).
//
// The split now matches where the information actually lives on the request path:
//   - HERE (pre-authn): requests WITHOUT a bearer token consume the per-IP backstop — the only surface an
//     unauthenticated flood can reach (401 probes, the public reads).
//   - authn (post-verify): every VERIFIED request consumes the per-subject budget (checkAuthedRequestRate),
//     and a request whose token FAILS verification is billed back to this per-IP bucket there — so carrying a
//     garbage bearer token buys a flood nothing over sending none.
// Deliberately still does NOT verify the JWT itself (perf RC#11a): authn is the security boundary and runs
// once per request; the header-presence check below only routes WHICH bucket pays, and cannot weaken either
// limit — a forged header defers the request to authn, where it is verified or billed to the IP.
//
// IP resolution stays delegated to the shared trusted-hop resolver: each trusted proxy APPENDS to
// X-Forwarded-For rather than replacing it, so the leftmost value is whatever the client sent. A local parse
// that took the first entry made the throttle trivially evadable (a fresh bucket per rotated header) — the
// exact bypass already fixed on the auth origin (W10/#14).

import { checkRequestRate, clientIpFromHeaders } from "@leadwolf/auth";
import type { Context, Next } from "hono";

/** The per-IP bucket key for this request, via the shared trusted-hop rule. Exported for authn, which bills
 *  failed-verification requests to the same bucket this middleware charges — one rule, one keyspace. */
export function ipKey(c: Context): string {
  return `ip:${clientIpFromHeaders({ get: (name) => c.req.header(name) ?? null })}`;
}

export async function rateLimit(c: Context, next: Next): Promise<void> {
  // A bearer-carrying request is charged per-subject (or billed to the IP on a failed verify) inside authn —
  // charging it here too would double-bill every authenticated request against the small unauth backstop.
  if (!c.req.header("authorization")) {
    await checkRequestRate(ipKey(c));
  }
  await next();
}
