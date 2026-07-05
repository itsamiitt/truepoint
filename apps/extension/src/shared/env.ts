// Per-environment origins. Defaults target production; a build can override via Vite `define`
// (see vite.config.ts) or the signed RemoteConfig at runtime (background/config/remoteConfig.ts).
// The extension only ever talks to these first-party origins (host_permissions in manifest.config.ts).

export const ENV = {
  apiOrigin: "https://api.truepoint.in",
  authOrigin: "https://auth.truepoint.in",
  appOrigin: "https://app.truepoint.in",
  /** OAuth client id for the extension's PKCE flow (public client). */
  oauthClientId: "truepoint-extension",
} as const;

export const API_BASE = `${ENV.apiOrigin}/api/v1`;
