// Per-environment origins. Defaults target production; a build can override via Vite `define`
// (see vite.config.ts) or the signed RemoteConfig at runtime (background/config/remoteConfig.ts).
// The extension only ever talks to these first-party origins (host_permissions in manifest.config.ts).

export const ENV = {
  apiOrigin: "https://api.truepoint.in",
  authOrigin: "https://auth.truepoint.in",
  appOrigin: "https://app.truepoint.in",
} as const;

export const API_BASE = `${ENV.apiOrigin}/api/v1`;

/** The companion-window handoff page (opened in a popup; runs the real web login). Doc 12 §6.1. NET-NEW page. */
export const HANDOFF_URL = `${ENV.appOrigin}/auth/extension`;

/** Extension-scoped token endpoints (Bearer / refresh-token; no cookie). Doc 12 §8. NET-NEW backend. */
export const EXT_TOKEN_BASE = `${API_BASE}/auth/extension`;
