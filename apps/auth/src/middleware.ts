// middleware.ts — sets the mandatory security headers on EVERY auth.* response (17 §1, mission): HSTS,
// X-Frame-Options: DENY, X-Content-Type-Options: nosniff, a nonce-based CSP with no inline scripts, and
// Referrer-Policy: no-referrer. The per-request nonce is forwarded so server components can tag scripts.

import { type NextRequest, NextResponse } from "next/server";

/**
 * Reject a server-action POST whose `Origin` is the literal string "null" — BEFORE Next tries to parse it.
 *
 * Next's action handler does `new URL(req.headers['origin']).host` with no try/catch
 * (next/dist/server/app-render/action-handler.js), so `Origin: null` — a real value browsers send for an
 * opaque origin, and one any client can set — throws `TypeError [ERR_INVALID_URL]` and surfaces as a 500.
 * Every server action on this origin is affected: sign-in, password reset, MFA, signup.
 *
 * This changes NO security decision. Next would refuse the request anyway; it just refused it as an
 * unhandled exception instead of an answer, which costs a 500 in the logs and an error-rate alert for a
 * request that was never going to be honoured. Deliberately does NOT strip the header to make the request
 * look same-origin — that would hand an opaque-origin caller the CSRF pass the check exists to withhold.
 * A 403 is the outcome the check intends, stated plainly.
 *
 * Remove this once the upstream parse is guarded.
 */
function isOpaqueOriginAction(request: NextRequest): boolean {
  return request.method === "POST" && request.headers.get("origin") === "null";
}

export function middleware(request: NextRequest): NextResponse {
  if (isOpaqueOriginAction(request)) {
    return NextResponse.json(
      { code: "forbidden", title: "Request origin is not allowed" },
      { status: 403 },
    );
  }
  const nonce = crypto.randomUUID().replace(/-/g, "");
  // challenges.cloudflare.com is allow-listed for the Turnstile bot check at the identifier step (ADR-0020).
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' https://challenges.cloudflare.com`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self' https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-csp-nonce", nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

// Run on every page/route except Next's static assets.
export const config = { matcher: "/((?!_next/static|_next/image|favicon.ico).*)" };
