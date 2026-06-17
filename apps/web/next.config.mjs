// next.config.mjs — the app shell. On Replit all three services share one domain; auth (port 3000) and
// the Hono API (port 3001) are proxied through Next.js rewrites so the browser sees a single origin.
/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@leadwolf/ui", "@leadwolf/types"],

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
      { source: "/.well-known/:path*", destination: "http://localhost:3000/auth/.well-known/:path*" },
      { source: "/auth/:path*", destination: "http://localhost:3000/auth/:path*" },
    ];
  },
};

export default nextConfig;
