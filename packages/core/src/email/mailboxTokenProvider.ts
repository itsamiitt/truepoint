// mailboxTokenProvider.ts — load a FRESH access token for a connected mailbox at send time (M12 P1, D1/D7).
// Reads the encrypted bundle (the ONLY server-side read-back of a credential), decrypts it, and PROACTIVELY
// refreshes when within REFRESH_SKEW of expiry — rotating the stored token. An invalid_grant (revoked/expired
// refresh token) marks the mailbox reauth_required (the "Reconnect" UX) and refuses the send instead of
// silently dropping mail. The credential never leaves the server; the read is RLS-scoped (withTenantTx). The
// network refresh happens OUTSIDE the DB tx (no provider call holds a connection). Deps injected for tests.

import {
  type TenantScope,
  mailboxRepository as defaultMailboxRepository,
  withTenantTx as defaultWithTenantTx,
} from "@leadwolf/db";
import { OAuthError, resolveOAuthProvider } from "./oauthProvider.ts";
import { decryptSecret, encryptSecret } from "./secretStore.ts";

const REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh ~5 min before expiry so an in-flight send never races an expiry

/** A send-time token failure. `reauth` true ⇒ the mailbox must be reconnected (the credential is dead). */
export class MailboxTokenError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly reauth: boolean,
  ) {
    super(message);
    this.name = "MailboxTokenError";
  }
}

/** The data-access seam — injectable for hermetic tests; defaults to the real @leadwolf/db repositories. */
export interface MailboxTokenDeps {
  withTenantTx: typeof defaultWithTenantTx;
  mailboxRepository: Pick<
    typeof defaultMailboxRepository,
    "getTokenBundle" | "updateOAuthToken" | "markReauthRequired"
  >;
}

const realDeps: MailboxTokenDeps = {
  withTenantTx: defaultWithTenantTx,
  mailboxRepository: defaultMailboxRepository,
};

/** Shape stored (encrypted) in mailbox_integration.oauth_token_enc. */
interface StoredBundle {
  access_token: string;
  refresh_token: string | null;
  token_type?: string;
}

export type MailboxTokenScope = TenantScope & { workspaceId: string };

/**
 * Resolve a usable access token for `mailboxId`, refreshing if near expiry. Throws MailboxTokenError on a
 * mailbox that is missing / flagged reauth / has no usable credential, and marks reauth_required when a refresh
 * is rejected (invalid_grant) or no refresh token is available.
 */
export async function getMailboxAccessToken(
  scope: MailboxTokenScope,
  mailboxId: string,
  deps: MailboxTokenDeps = realDeps,
): Promise<string> {
  const bundle = await deps.withTenantTx(scope, (tx) =>
    deps.mailboxRepository.getTokenBundle(tx, mailboxId),
  );
  if (!bundle)
    throw new MailboxTokenError("mailbox_not_found", "Mailbox not found in scope", false);
  if (bundle.reauthRequired) {
    throw new MailboxTokenError("reauth_required", "Mailbox needs reconnection", true);
  }
  if (!bundle.oauthTokenEnc) {
    throw new MailboxTokenError("no_token", "Mailbox has no OAuth credential", true);
  }

  const stored = JSON.parse(decryptSecret(bundle.oauthTokenEnc)) as StoredBundle;
  const expiresAtMs = bundle.oauthExpiresAt?.getTime() ?? 0;
  if (expiresAtMs - Date.now() > REFRESH_SKEW_MS) {
    return stored.access_token; // still fresh — no refresh, no write
  }

  // Near/at expiry → refresh. No refresh token ⇒ the mailbox can never self-heal: flag reauth.
  if (!stored.refresh_token) {
    await deps.withTenantTx(scope, (tx) =>
      deps.mailboxRepository.markReauthRequired(tx, mailboxId, "no_refresh_token"),
    );
    throw new MailboxTokenError("reauth_required", "Mailbox has no refresh token", true);
  }

  const provider = resolveOAuthProvider(bundle.provider);
  if (!provider) {
    throw new MailboxTokenError(
      "provider_unconfigured",
      `OAuth provider ${bundle.provider} is not configured`,
      false,
    );
  }

  let refreshed: Awaited<ReturnType<typeof provider.refresh>>;
  try {
    refreshed = await provider.refresh(stored.refresh_token); // network OUTSIDE any tx
  } catch (e) {
    if (e instanceof OAuthError && e.code === "invalid_grant") {
      await deps.withTenantTx(scope, (tx) =>
        deps.mailboxRepository.markReauthRequired(tx, mailboxId, "invalid_grant"),
      );
      throw new MailboxTokenError("reauth_required", "Refresh token was revoked", true);
    }
    throw e; // transient (5xx/network) — let the caller retry the send, don't burn the mailbox
  }

  const rotatedEnc = encryptSecret(
    JSON.stringify({
      access_token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken ?? stored.refresh_token, // Google omits it on refresh — keep ours
      token_type: refreshed.tokenType,
    } satisfies StoredBundle),
  );
  await deps.withTenantTx(scope, (tx) =>
    deps.mailboxRepository.updateOAuthToken(tx, mailboxId, rotatedEnc, refreshed.expiresAt),
  );
  return refreshed.accessToken;
}
