// next.config.mjs — the auth.truepoint.in app. Transpiles the workspace packages (they ship TS source)
// and disables the framework header that would leak the stack. Security headers are set in middleware.ts.
import { withSentryConfig } from "@sentry/nextjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // On Replit all services share one domain. basePath "/auth" puts every auth page and its
  // /_next/ asset chunks at /auth/_next/… so they never collide with the web app's own
  // /_next/ assets when both are proxied through the Next.js rewrites on port 5000.
  basePath: "/auth",
  // Edge (Caddy) owns compression — see apps/web/next.config.mjs for the full PA-7 reasoning.
  compress: false,
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
};

// ── Sentry ──────────────────────────────────────────────────────────────────────────────────────────────
// withSentryConfig wraps the build so server/edge bundles get instrumented and source maps can be uploaded.
//
// `tunnelRoute` is deliberately NOT set. It mounts a proxy API route to dodge ad-blockers, and this stack
// fronts every app with Caddy (and auth runs under basePath "/auth" behind its own middleware matcher) — a
// new top-level route there is a routing change to reason about, not a free win.
//
// Source-map upload is inert until SENTRY_AUTH_TOKEN is present in the build environment. Without it the
// build still succeeds; production stack traces just stay minified.
export default withSentryConfig(nextConfig, {
  org: "truepoint",
  project: "truepoint",
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // Upload a wider set of client files so frames resolve to real source rather than chunk offsets.
  widenClientFileUpload: true,
  // Keep the build log quiet outside CI.
  silent: !process.env.CI,
});
