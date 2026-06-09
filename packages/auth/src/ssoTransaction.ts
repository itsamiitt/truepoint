// ssoTransaction.ts — the short-lived pending-SSO state (Redis) that threads /sso (handoff) → the IdP →
// /sso/{oidc,saml}/callback together (17 §7). It carries the chosen tenant + protocol, the app's PKCE/return
// context, and the per-request relay/provider state used to validate the callback (CSRF binding). The durable
// session + cross-domain code are issued only after the assertion validates and JIT runs. 10-minute TTL.

import { randomBytes } from "node:crypto";
import Redis from "ioredis";
import { env } from "@leadwolf/config";

const redis = new Redis(env.REDIS_URL);
const TTL_SECONDS = 600;
const key = (id: string) => `ssotxn:${id}`;

export interface SsoTransaction {
  tenantId: string;
  protocol: "oidc" | "saml";
  appOrigin: string;
  codeChallenge: string;
  state: string;
  clientIp: string;
  relayState: string;
  providerState?: string;
  emailHint?: string;
  createdAt: number;
}

export type SsoTransactionInput = Omit<SsoTransaction, "createdAt">;

export async function createSsoTransaction(
  input: SsoTransactionInput,
): Promise<{ id: string; txn: SsoTransaction }> {
  const id = randomBytes(24).toString("base64url");
  const txn: SsoTransaction = { ...input, createdAt: Date.now() };
  await redis.set(key(id), JSON.stringify(txn), "EX", TTL_SECONDS);
  return { id, txn };
}

export async function getSsoTransaction(id: string): Promise<SsoTransaction | null> {
  const raw = await redis.get(key(id));
  return raw ? (JSON.parse(raw) as SsoTransaction) : null;
}

export async function deleteSsoTransaction(id: string): Promise<void> {
  await redis.del(key(id));
}
