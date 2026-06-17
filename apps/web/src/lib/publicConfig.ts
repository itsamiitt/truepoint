// publicConfig.ts — build-inlined PUBLIC config for the browser (the web-only counterpart to
// packages/config, which is server-side and holds secrets). (16 §10 documented exception.)
//
// On Replit (and any single-domain deployment where the auth + API services are proxied
// through the same origin as the web app) AUTH_ORIGIN and API_BASE are intentionally empty:
// all auth + API calls use relative URLs so the browser never makes a cross-origin fetch.
// APP_ORIGIN is derived from window.location.origin at runtime so it is correct whether the
// browser reaches the app via the Replit HTTPS proxy, localhost, or a custom domain.
export const AUTH_ORIGIN: string = process.env.NEXT_PUBLIC_AUTH_ORIGIN ?? "";
export const APP_ORIGIN: string =
  typeof window !== "undefined"
    ? window.location.origin
    : (process.env.NEXT_PUBLIC_APP_ORIGIN ?? "");
export const API_BASE: string = process.env.NEXT_PUBLIC_API_BASE ?? "";
