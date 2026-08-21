// next.config.mjs — the public developer portal (doc.truepoint.in; ADR-0048). A separate deploy on its own
// port (3007 — clear of auth 3000, api 3001, web 3002/5000, admin 3003, forge 3004, forge-api 3005,
// forge-worker health 3006) and its own origin, deliberately NOT in APP_ORIGINS: this surface is anonymous,
// holds no session, and adding it to the CORS/token-audience allowlist would widen that surface for nothing.
//
// It is also the only app in the fleet that imports no @leadwolf/config, no @leadwolf/db and no auth client,
// so `next build` here needs ZERO environment. That is a boundary, not a coincidence — see ADR-0048 §D2 and
// the `doc-app-holds-no-data-path` rule in .dependency-cruiser.cjs, which fails the build if anyone wires a
// data client into a marketing page.
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
  // No Content-Security-Policy yet. This app is the best CSP candidate in the fleet (no inline handlers, no
  // third-party origins, no user content) but Next still emits inline bootstrap scripts, so a real policy
  // needs a nonce plumbed through the layout and a report-only rollout against a live deployment. Adding a
  // guessed one here would fail silently in the browser rather than loudly in CI.
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
          ]
        : []),
    ];
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
