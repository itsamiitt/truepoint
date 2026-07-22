// publicConfig.ts — build-inlined PUBLIC config for the Forge operator console browser (the counterpart to
// apps/admin's publicConfig; packages/config is server-side and holds secrets). The console reuses the same
// auth origin + IdP as the rest of TruePoint (staff sign in through auth.* with the `pa` claim); the forge
// gate then verifies staff status by probing the forge-api `/bff/*` surface. Empty defaults = same-origin
// (relative) calls, matching the single-domain proxy deployment.
export const AUTH_ORIGIN: string = process.env.NEXT_PUBLIC_AUTH_ORIGIN ?? "";
export const APP_ORIGIN: string =
  typeof window !== "undefined"
    ? window.location.origin
    : (process.env.NEXT_PUBLIC_APP_ORIGIN ?? "");
// The console's API surface is its own BFF (forge-api /bff/*), NOT the main TruePoint api — inheriting
// NEXT_PUBLIC_API_BASE pointed every call at api.truepoint.in, which serves no /bff routes and no CORS
// for it (the launch 502-adjacent "couldn't reach the Forge API" bug). Default "" = relative same-origin
// calls; the forge.truepoint.in Caddy site routes /bff/* to forge-api:3005, so no CORS surface exists.
// Set NEXT_PUBLIC_FORGE_API_BASE only for a split-origin deployment (which must then add CORS to forge-api).
export const API_BASE: string = process.env.NEXT_PUBLIC_FORGE_API_BASE ?? "";
