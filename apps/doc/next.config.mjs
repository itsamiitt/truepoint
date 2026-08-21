// next.config.mjs — the public developer portal (doc.truepoint.in; ADR-0048). A separate deploy on its own
// port (3007 — clear of auth 3000, api 3001, web 3002/5000, admin 3003, forge 3004, forge-api 3005,
// forge-worker health 3006) and its own origin, deliberately NOT in APP_ORIGINS: this surface is anonymous,
// holds no session, and adding it to the CORS/token-audience allowlist would widen that surface for nothing.
//
// It is also the only app in the fleet that imports no @leadwolf/config, no @leadwolf/db and no auth client,
// so `next build` here needs ZERO environment. That is a boundary, not a coincidence — see ADR-0048 §D2 and
// the `doc-app-holds-no-data-path` rule in .dependency-cruiser.cjs, which fails the build if anyone wires a
// data client into a marketing page.
/** The policy itself — see the reasoning above `headers()` for what each directive is doing and what
 *  `script-src 'unsafe-inline'` costs. One directive per line so a diff shows which one changed. */
const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "img-src 'self' data:",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "upgrade-insecure-requests",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Edge (Caddy) owns compression — see apps/web/next.config.mjs for the full PA-7 reasoning.
  compress: false,
  poweredByHeader: false,
  reactStrictMode: true,
  // The workspace packages ship TS source. app-shell is here for the brand lockup ONLY (Logo/Brandmark/
  // Wordmark); its cmdk-bearing command palette lives behind the `@leadwolf/app-shell/palette` subpath and is
  // never reached from the barrel, so depending on the package does not drag cmdk into a route chunk.
  transpilePackages: ["@leadwolf/ui", "@leadwolf/app-shell"],
  // Rewrite barrel imports to their direct paths at compile time — /ui is one large barrel, so importing a
  // single component otherwise pulls the whole surface into that route's chunk. Build-time only.
  experimental: { optimizePackageImports: ["@leadwolf/ui"] },

  // ── Security headers. Same set the other four apps ship (E-6.2), with two deliberate differences.
  //
  // X-Frame-Options is DENY, not the customer app's SAMEORIGIN: nothing embeds a marketing page, and a page
  // whose whole job is to carry outbound calls-to-action has no reason to be frameable by anyone.
  //
  // HSTS stays gated on production for the same reason it is everywhere else: sent from a dev server it pins
  // `localhost` to HTTPS for the max-age and every app on localhost then fails to load until the pin is
  // cleared by hand. `preload` is deliberately not set — that is a browser-shipped list, slow to reverse.
  //
  // ── Content-Security-Policy ────────────────────────────────────────────────────────────────────────
  // Shipped ENFORCED, and deliberately honest about its one weak directive.
  //
  // `script-src` carries 'unsafe-inline' because Next emits inline bootstrap and RSC-flight scripts whose
  // contents differ per page. The two ways to tighten that both cost more than they buy here: static hashes
  // cannot cover per-page payloads, and a nonce must be minted per request — which would force every one of
  // these 21 prerendered routes to render dynamically, trading the app's entire static posture for one
  // directive. So it is not claimed to be strict. What it IS, is a real reduction of everything else:
  //
  //   base-uri 'none'        a injected <base> cannot re-point every relative URL on the page
  //   object-src 'none'      no plugin content, the classic bypass for a permissive script-src
  //   form-action 'none'     TRUE here — this site has no forms at all (ADR-0048 §D4), so an injected one
  //                          has nowhere to post. This is the directive 'unsafe-inline' would otherwise
  //                          leave most exposed.
  //   frame-ancestors 'none' the modern X-Frame-Options; both are sent, since the older header is still
  //                          what some browsers honour
  //   connect-src 'self'     an injected script cannot beacon anywhere off-origin
  //
  // None of these can break this app, and that is checkable rather than hopeful: the built HTML references
  // nothing off-origin but two plain navigations (app.truepoint.in and a mailto:, neither of which CSP
  // governs), Geist is self-hosted via next/font, there are no <img> tags, and the only data: URI is the
  // design system's inline SVG select-chevron in primitives.css — hence `img-src data:`.
  //
  // No report-to/report-uri: there is no collector to send violations to, and a reporting directive pointing
  // nowhere is decoration. Wire one when there is somewhere for it to land.
  //
  // Production-gated with HSTS, for the same reason: `next dev` uses eval for React Refresh, and a policy
  // that only bites in dev is a policy nobody keeps.
  async headers() {
    const securityHeaders = [
      // Never let a browser guess a response's type; a JSON endpoint sniffed as HTML is an XSS vector.
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Frame-Options", value: "DENY" },
      ...(process.env.NODE_ENV === "production"
        ? [
            {
              key: "Strict-Transport-Security",
              value: "max-age=63072000; includeSubDomains",
            },
            { key: "Content-Security-Policy", value: CSP },
          ]
        : []),
    ];
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
