// publicConfig.ts — build-inlined PUBLIC config for the browser (the web-only counterpart to
// packages/config, which is server-side and holds secrets). These NEXT_PUBLIC_* values are non-secret
// origins safe to ship to the client; real secrets never reach the browser. (16 §10 documented exception.)
export const AUTH_ORIGIN = process.env.NEXT_PUBLIC_AUTH_ORIGIN ?? "https://auth.truepoint.in";
export const APP_ORIGIN = process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://app.truepoint.in";
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "https://api.truepoint.in";
