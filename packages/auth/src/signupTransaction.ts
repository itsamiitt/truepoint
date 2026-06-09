// signupTransaction.ts — the short-lived pending-registration state (Redis) that threads /signup → /verify →
// /signup/profile together BEFORE an identity exists (ADR-0020). It holds the claimed email + the app's
// PKCE/return context + whether the email has been proven, but never any credential. The identity, its org
// placement, the durable session, and the cross-domain code are all created only at the final profile step.

import { randomBytes } from "node:crypto";
import Redis from "ioredis";
import { env } from "@leadwolf/config";

const redis = new Redis(env.REDIS_URL);
const TTL_SECONDS = 900; // 15 minutes — matches the email-code window
const key = (id: string) => `signuptxn:${id}`;

export interface SignupTransaction {
  email: string;
  appOrigin: string;
  codeChallenge: string;
  state: string;
  clientIp: string;
  emailVerified: boolean;
  createdAt: number;
}

export type SignupTransactionInput = Pick<
  SignupTransaction,
  "email" | "appOrigin" | "codeChallenge" | "state" | "clientIp"
>;

export async function createSignupTransaction(
  input: SignupTransactionInput,
): Promise<{ id: string; txn: SignupTransaction }> {
  const id = randomBytes(24).toString("base64url");
  const txn: SignupTransaction = { ...input, emailVerified: false, createdAt: Date.now() };
  await redis.set(key(id), JSON.stringify(txn), "EX", TTL_SECONDS);
  return { id, txn };
}

export async function getSignupTransaction(id: string): Promise<SignupTransaction | null> {
  const raw = await redis.get(key(id));
  return raw ? (JSON.parse(raw) as SignupTransaction) : null;
}

export async function patchSignupTransaction(
  id: string,
  patch: Partial<SignupTransaction>,
): Promise<void> {
  const cur = await getSignupTransaction(id);
  if (!cur) return;
  await redis.set(key(id), JSON.stringify({ ...cur, ...patch }), "KEEPTTL");
}

export async function deleteSignupTransaction(id: string): Promise<void> {
  await redis.del(key(id));
}
