// next.config.mjs — the auth.truepoint.in app. Transpiles the workspace packages (they ship TS source)
// and disables the framework header that would leak the stack. Security headers are set in middleware.ts.
/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: [
    "@leadwolf/ui",
    "@leadwolf/auth",
    "@leadwolf/db",
    "@leadwolf/types",
    "@leadwolf/config",
  ],
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

export default nextConfig;
