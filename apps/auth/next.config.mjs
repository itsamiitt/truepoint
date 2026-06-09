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
};

export default nextConfig;
