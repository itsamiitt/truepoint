// registerProviders.ts — wire the configured email providers onto the M12 seams once at API/worker startup
// (M12 P1, D1/D11). Two registrations:
//   • the OAuth provider (connect + token refresh) — registered ONLY when the Google client config is present,
//     so the connect flow + send-time refresh fail closed when unconfigured.
//   • the SEND adapter — always registered; it loads the per-mailbox credential FRESH at send time
//     (getMailboxAccessToken: decrypt + proactive refresh) and is gated upstream by the email.send flag + a
//     DNS-verified domain (dispatchOutreachSend), so a no-credential tenant never sends.
// Idempotent (the registries are keyed maps). Both apps/api and apps/workers call this at boot so a refresh
// during a worker send can resolve the provider. SES/Microsoft/SMTP register here as they land.

import { env } from "@leadwolf/config";
import { createGmailSender } from "./gmailSend.ts";
import { createGoogleOAuthProvider } from "./googleOAuth.ts";
import { getMailboxAccessToken } from "./mailboxTokenProvider.ts";
import { registerOAuthProvider } from "./oauthProvider.ts";
import { registerAdapter } from "./providerAdapter.ts";

export function registerEmailProviders(): void {
  if (
    env.GOOGLE_OAUTH_CLIENT_ID &&
    env.GOOGLE_OAUTH_CLIENT_SECRET &&
    env.GOOGLE_OAUTH_REDIRECT_URI
  ) {
    registerOAuthProvider(
      createGoogleOAuthProvider({
        clientId: env.GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
        redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
      }),
    );
  }

  registerAdapter("google", (identity) =>
    createGmailSender({
      getAccessToken: () =>
        getMailboxAccessToken(
          { tenantId: identity.tenantId, workspaceId: identity.workspaceId },
          identity.mailboxId,
        ),
      sendingDomain: identity.sendingDomain,
    }),
  );
}
