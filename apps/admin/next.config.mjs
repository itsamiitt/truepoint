// next.config.mjs — the internal staff console (admin.truepoint.internal, ADR-0011 / 13). A SEPARATE deploy
// from the customer app: its own port (3003 — clear of web 5000, auth 3000, api 3001) and origin. The app is
// read-mostly and talks to the apps/api `/admin/*` surface over HTTP (NEVER a privileged DB path of its own).
// transpilePackages: the workspace packages ship TS source, so Next must transpile them. No basePath: this is
// a standalone host, not proxied under another app's domain.
/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: [
    "@leadwolf/ui",
    "@leadwolf/app-shell",
    "@leadwolf/auth-client",
    "@leadwolf/types",
  ],
  // Tree-shake the barrel re-exports at import time. /ui is a single large barrel, so a component
  // importing one control pulled the whole surface into that route chunk; this rewrites such imports to their
  // direct paths during compilation. Build-time only — no runtime behaviour changes.
  // `@leadwolf/types` is a 75-line barrel of 74 `export *` lines carrying Zod SCHEMAS — runtime values, not
  // erased types — so importing one schema pulled the whole surface into that route's chunk. Listing it here
  // is what the plan's "subpath exports instead of the barrel" asks for, achieved by the compiler rewriting
  // barrel imports to their direct paths, rather than by rewriting several hundred import sites by hand.
  experimental: { optimizePackageImports: ["@leadwolf/ui", "@leadwolf/types"] },

  // ── Security headers (E-6.2). These apps shipped NONE — no HSTS, no nosniff, no framing policy.
  //
  // HSTS is gated on production deliberately. Sent from a dev server it pins `localhost` to HTTPS in the
  // developer's browser for the max-age, and every app on localhost then fails to load until the pin is
  // manually cleared — a trap that costs an afternoon and looks like a broken machine.
  //
  // `preload` is deliberately NOT set: it is a submission to a browser-shipped list and is slow and awkward
  // to reverse. That is a decision to take deliberately, not to inherit from a header someone added.
  //
  // No Content-Security-Policy here yet. A CSP that is too strict does not fail the build — it fails silently
  // in the browser, blocking scripts or styles on surfaces nobody re-tests. It wants a report-only rollout
  // against a real deployment, which is why the plan keeps it with the CDN work.
  async headers() {
    const securityHeaders = [
      // Never let a browser guess a response's type; a JSON endpoint sniffed as HTML is an XSS vector.
      { key: "X-Content-Type-Options", value: "nosniff" },
      // Full URL to same-origin, origin-only cross-origin, nothing over a downgrade — keeps ids and search
      // text in paths from leaking into third-party referrers.
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
