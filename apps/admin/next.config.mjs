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
};

export default nextConfig;
