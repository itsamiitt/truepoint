// mailboxConnectFlow.ts — the OAuth connect handshake for a Gmail/Microsoft mailbox (M12 P1, D1). Two steps:
//   startMailboxConnect (authed) mints PKCE + a CSRF state, persists an oauth_connect_state row (the PKCE
//     verifier encrypted at rest), and returns the provider consent URL.
//   completeMailboxConnect (session-less callback) consumes the state SINGLE-USE, exchanges the code, resolves
//     the account identity server-side, REQUIRES the send scope, encrypts the token bundle, and creates (or
//     re-auths) the workspace mailbox.
// No credential ever crosses the client (D7); the tenant/workspace/user are recovered from the state row bound
// under the authed start — never from anything the callback caller asserts. Audited on both connect + reconnect.
// The data-access layer is taken as a `deps` seam (defaulting to the real repositories) so the security
// invariants are unit-testable without a database — the same injectable-port discipline as the OAuth HTTP port.

import {
  type TenantScope,
  oauthConnectStateRepository as defaultConnectStateRepository,
  mailboxRepository as defaultMailboxRepository,
  withTenantTx as defaultWithTenantTx,
} from "@leadwolf/db";
import { writeAudit as defaultWriteAudit } from "../compliance/writeAudit.ts";
import { OAuthError, resolveOAuthProvider } from "./oauthProvider.ts";
import { generatePkce, randomState } from "./pkce.ts";
import { decryptSecret, encryptSecret } from "./secretStore.ts";

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes — the consent round-trip is short-lived
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export type MailboxOAuthProviderId = "google" | "microsoft";

/** The data-access seam — injectable for hermetic unit tests; defaults to the real @leadwolf/db repositories. */
export interface MailboxConnectDeps {
  withTenantTx: typeof defaultWithTenantTx;
  mailboxRepository: Pick<
    typeof defaultMailboxRepository,
    "insert" | "findIdByWorkspaceAddress" | "markConnected"
  >;
  connectStateRepository: Pick<typeof defaultConnectStateRepository, "create" | "consume">;
  writeAudit: typeof defaultWriteAudit;
}

const realDeps: MailboxConnectDeps = {
  withTenantTx: defaultWithTenantTx,
  mailboxRepository: defaultMailboxRepository,
  connectStateRepository: defaultConnectStateRepository,
  writeAudit: defaultWriteAudit,
};

export interface StartConnectInput {
  scope: TenantScope & { workspaceId: string };
  userId: string;
  provider: MailboxOAuthProviderId;
  loginHint?: string;
  /** A same-app ABSOLUTE PATH to return to (validated by the caller); never a full URL → no open redirect. */
  redirectAfter?: string | null;
}

export interface StartConnectResult {
  authorizeUrl: string;
}

/** Begin the connect: persist the handshake and hand back the provider consent URL. Throws OAuthError
 *  (provider_unconfigured) when the provider isn't registered, so the API fails closed with a clear 503. */
export async function startMailboxConnect(
  input: StartConnectInput,
  deps: MailboxConnectDeps = realDeps,
): Promise<StartConnectResult> {
  const provider = resolveOAuthProvider(input.provider);
  if (!provider) {
    throw new OAuthError(
      "provider_unconfigured",
      `OAuth provider ${input.provider} is not configured`,
      503,
    );
  }
  const pkce = generatePkce();
  const state = randomState();
  const verifierEnc = encryptSecret(pkce.verifier);

  await deps.withTenantTx(input.scope, (tx) =>
    deps.connectStateRepository.create(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      userId: input.userId,
      provider: input.provider,
      stateToken: state,
      pkceVerifierEnc: verifierEnc,
      redirectAfter: input.redirectAfter ?? null,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    }),
  );

  return {
    authorizeUrl: provider.authorizeUrl({
      state,
      codeChallenge: pkce.challenge,
      loginHint: input.loginHint,
    }),
  };
}

export type CompleteConnectOutcome =
  | {
      ok: true;
      mailboxId: string;
      address: string;
      reconnect: boolean;
      redirectAfter: string | null;
    }
  | { ok: false; reason: string; redirectAfter: string | null };

/** Finish the connect from the callback: consume the state (single-use → replay/CSRF safe), exchange the code,
 *  and persist the connected mailbox. Returns a typed outcome the route maps to a browser redirect — it never
 *  throws for an expected failure (denied consent, stale state, downgraded scope), only surfaces a reason. */
export async function completeMailboxConnect(
  args: { stateToken: string; code: string },
  deps: MailboxConnectDeps = realDeps,
): Promise<CompleteConnectOutcome> {
  const st = await deps.connectStateRepository.consume(args.stateToken);
  if (!st) return { ok: false, reason: "invalid_state", redirectAfter: null };

  const provider = resolveOAuthProvider(st.provider);
  if (!provider)
    return { ok: false, reason: "provider_unconfigured", redirectAfter: st.redirectAfter };

  let bundle: Awaited<ReturnType<typeof provider.exchangeCode>>;
  let identity: Awaited<ReturnType<typeof provider.fetchIdentity>>;
  try {
    const verifier = decryptSecret(st.pkceVerifierEnc);
    bundle = await provider.exchangeCode(args.code, verifier);
    identity = await provider.fetchIdentity(bundle.accessToken);
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof OAuthError ? e.code : "exchange_failed",
      redirectAfter: st.redirectAfter,
    };
  }

  // A mailbox that can't send is useless — reject a consent screen where the user unchecked the send scope.
  if (st.provider === "google" && !bundle.scope.includes(GMAIL_SEND_SCOPE)) {
    return { ok: false, reason: "missing_send_scope", redirectAfter: st.redirectAfter };
  }

  // The encrypted bundle holds the live tokens (access+refresh); the EXPIRY/SCOPES/account id are stored in the
  // CLEAR on the row so the refresh worker can act without decrypting (D7).
  const tokenEnc = encryptSecret(
    JSON.stringify({
      access_token: bundle.accessToken,
      refresh_token: bundle.refreshToken ?? null,
      token_type: bundle.tokenType,
    }),
  );

  const scope = { tenantId: st.tenantId, workspaceId: st.workspaceId };
  const { mailboxId, reconnect } = await deps.withTenantTx(scope, async (tx) => {
    const existingId = await deps.mailboxRepository.findIdByWorkspaceAddress(
      tx,
      st.workspaceId,
      identity.email,
    );
    const id =
      existingId ??
      (await deps.mailboxRepository.insert(tx, {
        tenantId: st.tenantId,
        workspaceId: st.workspaceId,
        ownerUserId: st.userId,
        provider: st.provider,
        address: identity.email,
      }));
    await deps.mailboxRepository.markConnected(tx, id, {
      oauthTokenEnc: tokenEnc,
      oauthExpiresAt: bundle.expiresAt,
      oauthScopes: bundle.scope,
      providerAccountId: identity.accountId,
    });
    await deps.writeAudit(tx, {
      tenantId: st.tenantId,
      workspaceId: st.workspaceId,
      actorUserId: st.userId,
      // The audit action vocabulary is a DB-enforced CHECK; a re-auth is the same `mailbox.connect` event with
      // a `reconnect` flag in metadata (avoids a lock-taking CHECK-widening migration on audit_log).
      action: "mailbox.connect",
      entityType: "mailbox_integration",
      entityId: id,
      metadata: { provider: st.provider, address: identity.email, reconnect: existingId !== null }, // never the token
    });
    return { mailboxId: id, reconnect: existingId !== null };
  });

  return {
    ok: true,
    mailboxId,
    address: identity.email,
    reconnect,
    redirectAfter: st.redirectAfter,
  };
}
