// Per-environment origins. Defaults target production; a build can override via Vite `define`
// (see vite.config.ts) or the signed RemoteConfig at runtime (background/config/remoteConfig.ts).
// The extension only ever talks to these first-party origins (host_permissions in manifest.config.ts).

export const ENV = {
  apiOrigin: "https://api.truepoint.in",
  authOrigin: "https://auth.truepoint.in",
  appOrigin: "https://app.truepoint.in",
} as const;

export const API_BASE = `${ENV.apiOrigin}/api/v1`;

/** The companion-window handoff page (opened in a popup; runs the real web login). Doc 12 §6.1. */
export const HANDOFF_URL = `${ENV.appOrigin}/auth/extension`;

/** Extension token endpoints — refresh/logout, body-based (no cookie). These live on the AUTH origin
 *  because minting needs the private signing key (apps/auth only). The SW calls them cross-origin; the
 *  extension id must be registered in EXTENSION_ORIGINS server-side for CORS to pass. Doc 12 §8. */
export const EXT_TOKEN_BASE = `${ENV.authOrigin}/auth/extension`;
