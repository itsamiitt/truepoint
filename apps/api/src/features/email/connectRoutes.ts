// connectRoutes.ts — the SESSION-LESS OAuth callback for connecting a Gmail/Microsoft mailbox (M12 P1, D1).
// The provider redirects the user's BROWSER here after consent; a top-level GET carries no Bearer token, so the
// tenant/workspace/user are recovered from the single-use `state` (oauth_connect_state) — NEVER from anything
// the caller asserts. Mounted BEFORE the authed email router (mirrors the webhook surface, whose `*` authn
// would otherwise 401 this session-less call). Always 302s back to the app with a status the UI renders; the
// redirect target is built SERVER-SIDE from NEXT_PUBLIC_APP_ORIGIN + a same-app path (no open redirect).

import { env } from "@leadwolf/config";
import { completeMailboxConnect } from "@leadwolf/core";
import { Hono } from "hono";
// Side-effect: ensure the OAuth providers are registered even if this router loads before the authed routes.
import "./oauthProviders.ts";

export const emailConnectRoutes = new Hono();

/** Build the post-callback redirect from the SERVER's own app origin + a validated same-app path. A path that
 *  isn't a safe `/...` (e.g. `//evil.com` or a full URL) is ignored and the default settings page is used. */
function appRedirect(path: string | null, params: Record<string, string>): string {
  const base = env.NEXT_PUBLIC_APP_ORIGIN ?? env.APP_ORIGINS[0];
  const safePath = path && /^\/(?!\/)/.test(path) ? path : "/settings/mailboxes";
  const url = new URL(safePath, base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

emailConnectRoutes.get("/mailboxes/connect/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const oauthError = c.req.query("error"); // provider-side: user denied consent, etc.
  if (oauthError) {
    return c.redirect(
      appRedirect(null, { connect: "error", reason: oauthError.slice(0, 60) }),
      302,
    );
  }
  if (!code || !state) {
    return c.redirect(appRedirect(null, { connect: "error", reason: "missing_params" }), 302);
  }

  const result = await completeMailboxConnect({ stateToken: state, code });
  if (result.ok) {
    return c.redirect(
      appRedirect(result.redirectAfter, {
        connect: result.reconnect ? "reconnected" : "connected",
        address: result.address,
      }),
      302,
    );
  }
  return c.redirect(
    appRedirect(result.redirectAfter, { connect: "error", reason: result.reason }),
    302,
  );
});
