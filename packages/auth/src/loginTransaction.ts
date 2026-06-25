// loginTransaction.ts — the short-lived pending-auth state (Redis) that threads the multi-step login
// (password → MFA → workspace) together BEFORE a durable session exists (17 §2). Holds the authenticated
// user + the app's PKCE/return context; the durable session + cross-domain code are only issued at
// finalizeLogin, after every required factor passes. 10-minute TTL to complete.

import { randomBytes } from "node:crypto";
import { env } from "@leadwolf/config";
import type { AuthMethod } from "@leadwolf/types";
import Redis from "ioredis";

// Lazy: constructing ioredis opens a socket + retry loop. Defer it so importing this module is
// side-effect-free (it's transpiled into the auth Next app; `next build` must not try to reach Redis).
let _redis: Redis | undefined;
// biome-ignore lint/suspicious/noAssignInExpressions: intentional lazy-singleton memoization (defer the socket).
const redis = (): Redis => (_redis ??= new Redis(env.REDIS_URL));
const TTL_SECONDS = 600;
const key = (id: string) => `logintxn:${id}`;

export interface LoginTransaction {
  userId: string;
  appOrigin: string;
  codeChallenge: string;
  state: string;
  clientIp: string;
  mfaVerified: boolean;
  // The primary-auth method this transaction was opened with (P1-01 Gate B). Set by each login edge
  // (password / magic_link / sso / signup→password) and enforced against the resolved tenant policy's
  // allowedMethods at finalizeLogin. OPTIONAL by design: a transaction created before this field existed (an
  // in-flight Redis row across a deploy) parses with `method` undefined, and the gate FAILS OPEN on a missing
  // method (no lockout) — it never blocks data it does not have.
  method?: AuthMethod;
  tenantId?: string; // chosen at the org-selection step (ADR-0019)
  workspaceId?: string;
  createdAt: number;
}

export type LoginTransactionInput = Pick<
  LoginTransaction,
  "userId" | "appOrigin" | "codeChallenge" | "state" | "clientIp" | "method"
>;

export async function createLoginTransaction(
  input: LoginTransactionInput,
): Promise<{ id: string; txn: LoginTransaction }> {
  const id = randomBytes(24).toString("base64url");
  const txn: LoginTransaction = { ...input, mfaVerified: false, createdAt: Date.now() };
  await redis().set(key(id), JSON.stringify(txn), "EX", TTL_SECONDS);
  return { id, txn };
}

export async function getLoginTransaction(id: string): Promise<LoginTransaction | null> {
  const raw = await redis().get(key(id));
  return raw ? (JSON.parse(raw) as LoginTransaction) : null;
}

export async function patchLoginTransaction(
  id: string,
  patch: Partial<LoginTransaction>,
): Promise<void> {
  const cur = await getLoginTransaction(id);
  if (!cur) return;
  await redis().set(key(id), JSON.stringify({ ...cur, ...patch }), "KEEPTTL");
}

export async function deleteLoginTransaction(id: string): Promise<void> {
  await redis().del(key(id));
}
