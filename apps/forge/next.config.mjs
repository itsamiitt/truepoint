// next.config.mjs — the Forge operator console (forge.truepoint.in; docs/planning/forge/13). A SEPARATE deploy:
// its own port (3004 — clear of web 5000, auth 3000, api 3001, admin 3003) and origin. Read-mostly; talks to
// apps/forge-api over HTTP (never a privileged DB path of its own). transpilePackages: the workspace packages
// ship TS source. No basePath: standalone host on its own subdomain.
/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@leadwolf/ui", "@leadwolf/types"],
};

export default nextConfig;
