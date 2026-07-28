// connectCrm.ts — the server-side OAuth connect flow for a CRM (crm-sync 00 §5.2). Clone of the
// connectMailbox shape, but with the full authorization-code + PKCE dance the mailbox P0 path deferred.
//
// TWO CALLS, because an OAuth connect is two requests with an untrusted hop between them:
//   startCrmConnect    — POST /api/v1/crm/connections : mint state + PKCE, persist the handshake, return the
//                        provider's authorize URL for the browser to follow.
//   completeCrmConnect — GET  /api/v1/crm/oauth/callback : consume the state, exchange the code, validate
//                        what came back, encrypt, store, seed mappings, audit.
//
// EVERY security decision in this file is about the hop. Enumerated so none of them reads as incidental:
//
//  1. TENANCY COMES FROM THE SESSION, NEVER THE CALLBACK. The handshake row carries the workspace that
//     started it, and completeCrmConnect requires the caller to pass the VERIFIED session scope and refuses
//     if the two disagree. A callback query parameter must never be able to select a tenant — that is the
//     single highest-stakes property here (00 §5.2, truepoint-security access-control).
//  2. STATE IS SINGLE-USE AND ATOMIC. Enforced in crmOauthStateRepository.consume, in one UPDATE.
//  3. PKCE. The verifier never leaves the server: it is encrypted at rest and only ever handed to the token
//     exchange. Even an attacker who intercepts the authorization code cannot redeem it.
//  4. THE SFDC-RETURNED instance_url IS HOSTILE INPUT. Salesforce tells us which host to call for the rest
//     of this connection's life; that is an attacker-influenceable outbound URL, so it is SSRF-validated
//     AND allow-listed to Salesforce's own domains before it is ever persisted (00 §5.2, integrations).
//  5. GRANTED SCOPES MUST NOT EXCEED REQUESTED. A provider that returns broader scopes than we asked for is
//     refused rather than silently accepted — least privilege has to be checked, not just requested.
//  6. NOTHING IS AUDITED WITH TOKEN MATERIAL. The audit row carries the provider and the account id only.
//
// The connection lands with sync_mode='shadow' (the schema default): connecting a CRM never starts moving
// data. An operator flips it to 'enforce' explicitly, and that is a separate audited call.

import { createHash, randomBytes } from "node:crypto";
import {
  type TenantScope,
  crmConnectionRepository,
  crmFieldMappingRepository,
  crmOauthStateRepository,
  withTenantTx,
} from "@leadwolf/db";
import type { CrmProvider } from "@leadwolf/types";
import { writeAudit } from "../compliance/writeAudit.ts";
import { assertSafeWebhookUrl } from "../webhooks/ssrfGuard.ts";
import { decryptCrmSecret, encryptCrmSecret, encryptCrmTokenBundle } from "./crmSecretStore.ts";
import { defaultMappingsFor } from "./defaultMappings.ts";
import type { CrmConnector, CrmTokenBundle } from "./port.ts";

/** A connect that failed a security check. The `reason` is a stable code — safe to log, never a secret. */
export class CrmConnectError extends Error {
  constructor(readonly reason: CrmConnectErrorReason) {
    super(`crm connect refused: ${reason}`);
    this.name = "CrmConnectError";
  }
}

export type CrmConnectErrorReason =
  | "state_invalid" // missing / already consumed / expired — deliberately not distinguished
  | "workspace_mismatch" // the handshake belongs to a different workspace than the session
  | "provider_mismatch"
  | "verifier_missing"
  | "scopes_exceeded"
  | "instance_url_rejected";

/**
 * Salesforce hosts we will talk to. The SSRF guard blocks private/metadata addresses, but "not private" is
 * not the same as "is Salesforce" — without this list a compromised or spoofed token response could point
 * the connection at any public host on the internet and we would happily send it a customer's data forever.
 */
const SFDC_HOST_SUFFIXES = [".salesforce.com", ".force.com"] as const;

function isAllowedSalesforceHost(host: string): boolean {
  const h = host.toLowerCase();
  return SFDC_HOST_SUFFIXES.some((suffix) => h.endsWith(suffix));
}

/**
 * Validate the instance URL a provider handed back before it is persisted or called.
 *
 * Two independent gates, both required: the shared SSRF guard (scheme, private ranges, cloud-metadata
 * hosts, DNS resolution) and the domain allow-list. Either one alone is insufficient — the guard would pass
 * `https://evil.example.com`, and a suffix check alone would pass `https://127.0.0.1.salesforce.com.evil`
 * only if someone wrote it sloppily, but more importantly would not catch a Salesforce-looking host that
 * resolves to a private address.
 */
export async function assertSafeInstanceUrl(rawUrl: string): Promise<string> {
  let url: URL;
  try {
    url = await assertSafeWebhookUrl(rawUrl);
  } catch {
    throw new CrmConnectError("instance_url_rejected");
  }
  if (url.protocol !== "https:" || !isAllowedSalesforceHost(url.hostname)) {
    throw new CrmConnectError("instance_url_rejected");
  }
  return url.origin;
}

/**
 * Refuse a grant broader than we asked for.
 *
 * Compared case-insensitively as sets. A provider returning FEWER scopes is allowed through here — that is
 * a capability problem the feature surfaces when a call fails, not a security one — but a provider
 * returning MORE than requested means the consent screen did something other than what we asked, and
 * accepting it silently would make the least-privilege scope list decorative.
 */
export function assertScopesNotBroadened(requested: string[], granted: string[]): void {
  const asked = new Set(requested.map((s) => s.toLowerCase()));
  const extra = granted.map((s) => s.toLowerCase()).filter((s) => !asked.has(s));
  if (extra.length > 0) throw new CrmConnectError("scopes_exceeded");
}

/** RFC 7636 S256: verifier = 43-128 chars of unreserved charset; challenge = base64url(sha256(verifier)). */
export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export interface StartCrmConnectInput {
  scope: TenantScope & { workspaceId: string };
  userId: string;
  provider: CrmProvider;
  connector: CrmConnector;
  redirectUri: string;
  scopes: string[];
  environment?: "production" | "sandbox";
}

export interface StartCrmConnectResult {
  authorizeUrl: string;
  state: string;
}

/**
 * Mint the handshake and return the provider's authorize URL.
 *
 * No `crm_connections` row is created here. A user who abandons the consent screen would otherwise leave a
 * permanent pending connection behind on every attempt; the handshake row expires on its own instead.
 */
export async function startCrmConnect(input: StartCrmConnectInput): Promise<StartCrmConnectResult> {
  const state = randomBytes(32).toString("base64url");
  const { verifier, challenge } = generatePkcePair();
  const environment = input.environment ?? "production";

  await withTenantTx(input.scope, (tx) =>
    crmOauthStateRepository.insert(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      ownerUserId: input.userId,
      provider: input.provider,
      state,
      codeVerifierEnc: encryptCrmSecret(verifier),
      redirectUri: input.redirectUri,
      environment,
      scopes: input.scopes,
    }),
  );

  return {
    authorizeUrl: input.connector.buildAuthorizeUrl({
      state,
      codeChallenge: challenge,
      redirectUri: input.redirectUri,
      scopes: input.scopes,
      env: environment,
    }),
    state,
  };
}

export interface CompleteCrmConnectInput {
  /** The VERIFIED session scope. Never derived from the callback query string. */
  sessionScope: TenantScope & { workspaceId: string };
  userId: string;
  state: string;
  code: string;
  connector: CrmConnector;
}

export interface CompleteCrmConnectResult {
  connectionId: string;
  provider: string;
  externalAccountId: string | null;
  /** The connection's ACTUAL mode after the connect — 'shadow' on a first connect, unchanged on a reconnect. */
  syncMode: string;
  /** Rows the default seed actually inserted; 0 on a reconnect, whose existing mappings are left alone. */
  seededMappings: number;
  /** True when this re-authorised an existing (workspace, provider, CRM org) rather than creating one. */
  reconnect: boolean;
}

/**
 * Consume the handshake, exchange the code, validate everything that came back, and store the connection.
 *
 * The token exchange happens OUTSIDE the tenant transaction on purpose: it is a network call to a third
 * party with its own latency and failure modes, and holding a Postgres transaction (and a pooled connection)
 * open across it is how a slow provider turns into connection-pool exhaustion for every tenant.
 */
export async function completeCrmConnect(
  input: CompleteCrmConnectInput,
): Promise<CompleteCrmConnectResult> {
  // 1. Single-use, atomic, expiry-checked. Owner connection — see the repository note on why.
  const handshake = await crmOauthStateRepository.consume(input.state);
  if (!handshake) throw new CrmConnectError("state_invalid");

  // 2. The callback cannot choose a tenant. Both tiers are compared.
  if (
    handshake.workspaceId !== input.sessionScope.workspaceId ||
    handshake.tenantId !== input.sessionScope.tenantId
  ) {
    throw new CrmConnectError("workspace_mismatch");
  }
  if (handshake.provider !== input.connector.provider) {
    throw new CrmConnectError("provider_mismatch");
  }
  if (!handshake.codeVerifierEnc) throw new CrmConnectError("verifier_missing");

  // 3. PKCE: the verifier is decrypted only to be handed to the exchange.
  const verifier = decryptCrmSecret(handshake.codeVerifierEnc);
  const environment = handshake.environment === "sandbox" ? "sandbox" : "production";

  const bundle: CrmTokenBundle = await input.connector.exchangeCode({
    code: input.code,
    codeVerifier: verifier,
    redirectUri: handshake.redirectUri ?? "",
    env: environment,
  });

  // 4. Least privilege is CHECKED, not just requested.
  const requested = Array.isArray(handshake.scopes) ? (handshake.scopes as string[]) : [];
  if (requested.length > 0) assertScopesNotBroadened(requested, bundle.scopes ?? []);

  // 5. The provider-supplied API base is hostile input until proven otherwise.
  const instanceUrl = bundle.instanceUrl ? await assertSafeInstanceUrl(bundle.instanceUrl) : null;

  const scope = { tenantId: handshake.tenantId, workspaceId: handshake.workspaceId };

  return withTenantTx<CompleteCrmConnectResult>(scope, async (tx) => {
    // RECONNECT vs FIRST CONNECT. uniq_crm_connections_ws_provider_account allows exactly one connection per
    // (workspace, provider, CRM org), so re-authorising an already-connected org must UPDATE that row rather
    // than insert a second one — otherwise every re-auth fails on the unique index. The account id only
    // becomes known at the exchange, which is why this lookup lives here and not at the start of the flow.
    const existingId = bundle.externalAccountId
      ? await crmConnectionRepository.findIdByWorkspaceProviderAccount(
          tx,
          scope.workspaceId,
          handshake.provider,
          bundle.externalAccountId,
        )
      : null;

    const connectionId =
      existingId ??
      (await crmConnectionRepository.insert(tx, {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        ownerUserId: input.userId,
        provider: handshake.provider,
        environment,
      }));

    await crmConnectionRepository.markConnected(tx, connectionId, {
      oauthTokenEnc: encryptCrmTokenBundle({ ...bundle, instanceUrl: instanceUrl ?? undefined }),
      tokenExpiresAt: bundle.expiresAt ? new Date(bundle.expiresAt) : null,
      scopes: bundle.scopes ?? [],
      externalAccountId: bundle.externalAccountId ?? null,
      instanceUrl,
    });

    const seededMappings = await crmFieldMappingRepository.seedDefaults(
      tx,
      scope,
      connectionId,
      defaultMappingsFor(handshake.provider as CrmProvider).map((m) => ({
        objectType: m.objectType,
        tpField: m.tpField,
        crmField: m.crmField,
        direction: m.direction,
        authority: m.authority ?? null,
        confThreshold: m.confThreshold ?? null,
        transform: m.transform,
        isDedupKey: m.isDedupKey ?? false,
        enabled: m.enabled,
      })),
    );

    // 6. IDs + provider only. No token, no scopes-as-secrets, no instance credentials.
    await writeAudit(tx, {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      actorUserId: input.userId,
      action: "crm.connect",
      entityType: "crm_connections",
      entityId: connectionId,
      metadata: {
        provider: handshake.provider,
        externalAccountId: bundle.externalAccountId ?? null,
        environment,
        reconnect: existingId !== null,
      },
    });

    // Read the mode back rather than asserting it. A FIRST connect is 'shadow' (the schema default), but a
    // RECONNECT of a connection an operator already promoted stays 'enforce' — markConnected deliberately
    // does not touch sync_mode. Returning a hardcoded 'shadow' here would tell the caller (and the UI) that
    // an enforcing connection had been demoted, which is exactly the kind of quiet lie that gets believed.
    const stored = await crmConnectionRepository.getById(tx, connectionId);

    return {
      connectionId,
      provider: handshake.provider,
      externalAccountId: bundle.externalAccountId ?? null,
      syncMode: stored?.syncMode ?? "shadow",
      seededMappings,
      reconnect: existingId !== null,
    };
  });
}
