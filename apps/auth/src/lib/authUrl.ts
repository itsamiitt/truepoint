// authUrl.ts — build an absolute URL into the auth origin. The auth app runs at basePath "/auth"
// (next.config.mjs), so EVERY link into it — including the one-click links mailed to users — must carry the
// "/auth" prefix or it 404s. This is AUTH-062: the forgot-password reset link and the magic-link both built
// `${AUTH_ORIGIN}/reset` / `${AUTH_ORIGIN}/magic/confirm` WITHOUT the prefix, so the emails dead-ended even
// with a working transport. Centralize the prefix here so a constructed auth URL cannot drop it again.
export const AUTH_BASE_PATH = "/auth";

/**
 * Absolute auth-origin URL for an in-app path. `path` must be the app-relative path (starting with "/")
 * and may include a query string. `origin` is `env.AUTH_ORIGIN` — the bare origin with NO path (may be an
 * empty string on single-domain deploys, in which case the result is a root-relative `/auth/...` URL that
 * the `/auth/:path*` rewrite proxies).
 */
export function authUrl(origin: string, path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${origin}${AUTH_BASE_PATH}${p}`;
}
