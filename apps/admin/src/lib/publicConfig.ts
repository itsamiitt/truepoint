// publicConfig.ts — build-inlined PUBLIC config for the staff console browser (the admin counterpart to
// apps/web's publicConfig; packages/config is server-side and holds secrets). The console reuses the same
// auth origin + IdP as the customer app (ADR-0034 interim: staff sign in through auth.* with the `pa` claim);
// the admin gate then verifies platform-admin via the api `/admin/*` surface. Empty defaults = same-origin
// (relative) calls, matching the single-domain proxy deployment.
export const AUTH_ORIGIN: string = process.env.NEXT_PUBLIC_AUTH_ORIGIN ?? "";
export const APP_ORIGIN: string =
  typeof window !== "undefined"
    ? window.location.origin
    : (process.env.NEXT_PUBLIC_APP_ORIGIN ?? "");
export const API_BASE: string = process.env.NEXT_PUBLIC_API_BASE ?? "";
