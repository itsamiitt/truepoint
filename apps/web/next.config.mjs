// next.config.mjs — the app shell. On Replit all three services share one domain; auth (port 3000) and
// the Hono API (port 3001) are proxied through Next.js rewrites so the browser sees a single origin.
/** @type {import('next').NextConfig} */
const nextConfig = {
  // Compression happens at the edge (deploy/Caddyfile `encode zstd gzip`) — the exact reasoning that removed
  // hono's compress() from apps/api (its app.ts:106 comment): Next's default gzip makes Caddy SKIP the body
  // (already Content-Encoded), so we'd never get zstd (~10-15% smaller on HTML/JSON) AND we'd burn gzip CPU
  // on the same event loop that renders. Perf-checklist PA-7.
  compress: false,
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
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
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
  async rewrites() {
    return [
      // ── Hono API (port 3001) ──────────────────────────────────────────────
      { source: "/api/:path*", destination: "http://localhost:3001/api/:path*" },
      { source: "/health", destination: "http://localhost:3001/health" },

      // ── Auth service (port 3000) ─────────────────────────────────────────
      // The auth app runs with basePath="/auth" so every page, asset, and API route
      // lives under /auth/*. A single catch-all here proxies the whole service with
      // no /_next/ collision against the web app's own asset chunks.
      // Note: /.well-known/jwks.json lives in apps/auth — rewrite it separately.
      // basePath "/auth" affects ALL routes in the auth app, so /.well-known/* is at /auth/.well-known/*
      {
        source: "/.well-known/:path*",
        destination: "http://localhost:3000/auth/.well-known/:path*",
      },
      { source: "/auth/:path*", destination: "http://localhost:3000/auth/:path*" },
    ];
  },
};

export default nextConfig;
