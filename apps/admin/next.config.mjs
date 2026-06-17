// next.config.mjs — the internal staff console (admin.truepoint.internal, ADR-0011 / 13). A SEPARATE deploy
// from the customer app: its own port (3003 — clear of web 5000, auth 3000, api 3001) and origin. The app is
// read-mostly and talks to the apps/api `/admin/*` surface over HTTP (NEVER a privileged DB path of its own).
// transpilePackages: the workspace packages ship TS source, so Next must transpile them. No basePath: this is
// a standalone host, not proxied under another app's domain.
/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@leadwolf/ui", "@leadwolf/types"],
};

export default nextConfig;
