// origins.ts — the ONE place the extension's first-party origins are decided, shared by the runtime
// (shared/env.ts) and the build (vite.config.ts → `define`, manifest.config.ts → host_permissions).
//
// It exists because those three had drifted apart. `shared/env.ts` hard-coded production and pointed at a
// Vite `define` that vite.config.ts did not have, so a development build silently pointed the service worker
// at PRODUCTION — and a reveal triggered while developing spent real credits against a real tenant. The
// manifest's host_permissions were production-only too, so a dev build could not have reached localhost even
// if the origins had been right.
//
// Kept dependency-free and side-effect-free on purpose: vite.config.ts and manifest.config.ts import it at
// BUILD time (node), while shared/env.ts imports it at RUNTIME (the service worker).

export interface ExtensionOrigins {
  api: string;
  auth: string;
  app: string;
}

/** Production — also the fallback whenever nothing was injected, so a misconfigured build fails toward the
 *  real origins rather than toward a localhost that does not exist for a user. */
export const PRODUCTION_ORIGINS: ExtensionOrigins = {
  api: "https://api.truepoint.in",
  auth: "https://auth.truepoint.in",
  app: "https://app.truepoint.in",
};

/** Local development. Ports match the services' own defaults (api 3001, auth 3000, web 3002 — the same
 *  mapping docker-compose documents). */
export const DEVELOPMENT_ORIGINS: ExtensionOrigins = {
  api: "http://localhost:3001",
  auth: "http://localhost:3000",
  app: "http://localhost:3002",
};

/** Vite passes `mode`; only an explicit development build gets local origins. Anything else — production,
 *  a preview, an unrecognised mode — resolves to production, because pointing at localhost by accident is a
 *  broken extension while pointing at production by accident spends money. */
export function originsForMode(mode: string | undefined): ExtensionOrigins {
  return mode === "development" ? DEVELOPMENT_ORIGINS : PRODUCTION_ORIGINS;
}

/** The `host_permissions` entries the manifest needs for a given mode. LinkedIn is always present (it is what
 *  the content script runs on); the API origin has to match whatever the SW will actually call, or a dev
 *  build is blocked by the very permission model that protects the release build. */
export function hostPermissionsForMode(mode: string | undefined): string[] {
  const origins = originsForMode(mode);
  return [`${origins.api}/*`, "https://*.linkedin.com/*"];
}
