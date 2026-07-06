// authLink.ts — build a deep link from the app into the auth-origin account-security screen. The auth app
// runs at basePath "/auth" (apps/auth/next.config.mjs), so every link into it MUST carry the "/auth" prefix
// or it 404s. This is AUTH-062: SecurityPanel's deep links built `${AUTH_ORIGIN}/account/security` WITHOUT
// the prefix, so "Change password" / "Manage two-step" / "Manage sessions" / "View login history" all
// dead-ended — the reason a user "cannot manage their security settings". Centralized + tested here so the
// prefix cannot be dropped again. `origin` is `AUTH_ORIGIN` from publicConfig (may be "" on single-domain
// deploys, yielding a root-relative `/auth/...` URL the `/auth/:path*` rewrite proxies).
export const AUTH_BASE_PATH = "/auth";

export function authSecurityUrl(origin: string, section?: string): string {
  return `${origin}${AUTH_BASE_PATH}/account/security${section ? `#${section}` : ""}`;
}
