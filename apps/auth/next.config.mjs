// next.config.mjs — the auth.truepoint.in app. Transpiles the workspace packages (they ship TS source)
// and disables the framework header that would leak the stack. Security headers are set in middleware.ts.
/** @type {import('next').NextConfig} */
const nextConfig = {
  // On Replit all services share one domain. basePath "/auth" puts every auth page and its
  // /_next/ asset chunks at /auth/_next/… so they never collide with the web app's own
  // /_next/ assets when both are proxied through the Next.js rewrites on port 5000.
  basePath: "/auth",
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: [
    "@leadwolf/ui",
    "@leadwolf/auth",
    "@leadwolf/db",
    "@leadwolf/types",
    "@leadwolf/config",
  ],
  // Tree-shake the @leadwolf/ui barrel at import time, matching web/admin/forge. This app was the only one
  // without it: a component importing one control pulled the whole barrel into that route's chunk, and the
  // auth screens are the FIRST thing an unauthenticated visitor downloads.
  // `@leadwolf/types` is a 75-line barrel of 74 `export *` lines carrying Zod SCHEMAS — runtime values, not
  // erased types — so importing one schema pulled the whole surface into that route's chunk. Listing it here
  // is what the plan's "subpath exports instead of the barrel" asks for, achieved by the compiler rewriting
  // barrel imports to their direct paths, rather than by rewriting several hundred import sites by hand.
  experimental: { optimizePackageImports: ["@leadwolf/ui", "@leadwolf/types"] },
  // Server-only / native deps reached via the transpiled workspace packages above. Keep them OUT of the
  // webpack bundle and `require()` them at runtime from node_modules — otherwise webpack tries to parse
  // @node-rs/argon2's native .node binary and the build fails. (They run only in server routes/actions.)
  serverExternalPackages: [
    "@node-rs/argon2",
    "postgres",
    "ioredis",
    "rate-limiter-flexible",
    "nodemailer",
  ],
  // serverExternalPackages doesn't reliably externalize a native dep reached THROUGH a transpilePackages
  // workspace package (@leadwolf/auth → @node-rs/argon2), so force it into the server bundle's externals:
  // webpack then emits a runtime require() instead of trying to parse the .node binary. nodemailer is added
  // too — it does dynamic transport requires that webpack can't statically bundle cleanly.
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [...(config.externals ?? []), "@node-rs/argon2", "nodemailer"];
    }
    return config;
  },

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
