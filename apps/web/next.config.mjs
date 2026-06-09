// next.config.mjs — the app.truepoint.in application shell. Transpiles the shared UI package and drops the
// framework header. (Appears in the architecture map's unassigned[] as a framework-mandated app-root file.)
/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@leadwolf/ui"],
};

export default nextConfig;
