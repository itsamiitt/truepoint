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

/**
 * The same prefix for an IN-PAGE link — `authPath("/forgot?x=1")` → `"/auth/forgot?x=1"`.
 *
 * AUTH-062 fixed the MAILED links and left the in-page ones broken, because the failure looks like a framework
 * feature and is not one: `basePath` is applied by `next/link`, the router and `redirect()`, but NOT to a raw
 * `<a href="/forgot">`, which the browser resolves against the ORIGIN. Served at auth.truepoint.in/auth/password,
 * that anchor navigates to auth.truepoint.in/forgot — outside the basePath — and 404s. Nine anchors shipped that
 * way, including the only route to the forgot-password screen ("Forgot password?" on /password), which is why
 * password reset was unreachable even though the page and its action worked.
 *
 * A helper rather than `next/link` on purpose: these screens are server-rendered and no-JS-friendly by design
 * (17 §2), so the correct href must be in the HTML with no client runtime involved, and the prefix must come
 * from ONE constant that authUrl already shares — not from framework behaviour a future config change silently
 * alters.
 */
export function authPath(path: string): string {
  return authUrl("", path);
}
