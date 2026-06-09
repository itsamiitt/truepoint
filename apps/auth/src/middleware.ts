// middleware.ts — sets the mandatory security headers on EVERY auth.* response (17 §1, mission): HSTS,
// X-Frame-Options: DENY, X-Content-Type-Options: nosniff, a nonce-based CSP with no inline scripts, and
// Referrer-Policy: no-referrer. The per-request nonce is forwarded so server components can tag scripts.

import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest): NextResponse {
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
