// next.config.mjs — the Forge operator console (forge.truepoint.in; docs/planning/forge/13). A SEPARATE deploy:
// its own port (3004 — clear of web 5000, auth 3000, api 3001, admin 3003) and origin. Read-mostly; talks to
// apps/forge-api over HTTP (never a privileged DB path of its own). transpilePackages: the workspace packages
// ship TS source. No basePath: standalone host on its own subdomain.
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
