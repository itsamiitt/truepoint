// Per-environment origins. Production by default; a development build overrides them through the Vite
// `define` in vite.config.ts. The extension only ever talks to these first-party origins (host_permissions in
// manifest.config.ts, derived from the same source — shared/origins.ts).
//
// The `define` this comment used to promise did not exist. env.ts hard-coded production, vite.config.ts had no
// `define` at all, so `bun run dev` pointed the service worker at PRODUCTION — and a reveal triggered while
// developing spent real credits against a real tenant. The injection is now real, and the constant below is
// the fallback rather than the only value.

import { PRODUCTION_ORIGINS } from "./origins.ts";

/** Injected by vite.config.ts at build time. Declared (not imported) because `define` performs a textual
 *  replacement — the identifier does not exist unless the build substituted it, hence the `typeof` guard. */
declare const __TP_ORIGINS__: { api: string; auth: string; app: string } | undefined;

const injected = typeof __TP_ORIGINS__ === "undefined" ? undefined : __TP_ORIGINS__;

export const ENV = {
  apiOrigin: injected?.api ?? PRODUCTION_ORIGINS.api,
  authOrigin: injected?.auth ?? PRODUCTION_ORIGINS.auth,
  appOrigin: injected?.app ?? PRODUCTION_ORIGINS.app,
} as const;

export const API_BASE = `${ENV.apiOrigin}/api/v1`;

/** The companion-window handoff page (opened in a popup; runs the real web login). Doc 12 §6.1. */
export const HANDOFF_URL = `${ENV.appOrigin}/auth/extension`;

/** Extension token endpoints — refresh/logout, body-based (no cookie). These live on the AUTH origin
 *  because minting needs the private signing key (apps/auth only). The SW calls them cross-origin; the
 *  extension id must be registered in EXTENSION_ORIGINS server-side for CORS to pass. Doc 12 §8. */
export const EXT_TOKEN_BASE = `${ENV.authOrigin}/auth/extension`;
