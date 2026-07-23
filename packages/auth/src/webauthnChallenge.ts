// webauthnChallenge.ts — short-lived WebAuthn ceremony challenges (AUTH-024 foundation). During a
// registration or authentication ceremony the server issues a random challenge, stashes it keyed by the user
// (5-min TTL), and the authenticator's signed response MUST echo it — the anti-replay binding at the heart of
// WebAuthn. Redis-backed so an abandoned ceremony expires on its own, and SINGLE-USE (consume atomically
// GET+DELs) so a captured challenge can't be replayed. Library-independent: the crypto-heavy options/attestation/
// assertion verification (a WebAuthn library) is the SEPARATE, specialist-review-gated slice — this only stores
// and consumes the challenge string those steps bind to. Inert until that ceremony wires it.

import { env } from "@leadwolf/config";
import Redis from "ioredis";

// Lazy singleton — constructing ioredis opens a socket + retry loop; defer it so importing this module is
// side-effect-free (it is reachable from the auth Next app's module graph, and `next build` must not hit Redis).
let _redis: Redis | undefined;
const redis = (): Redis =>
  // biome-ignore lint/suspicious/noAssignInExpressions: intentional lazy-singleton memoization (defer the socket).
  (_redis ??= new Redis(env.REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 }));

export type WebauthnCeremony = "register" | "authenticate";

const CHALLENGE_TTL_SECONDS = 300; // 5-minute window to complete a ceremony

/** Redis key for a user's pending challenge of a given ceremony kind. One in flight per (user, kind) — a new
 *  ceremony overwrites the previous, so a stale challenge can never be used after a fresh one is issued. */
function challengeKey(ceremony: WebauthnCeremony, userId: string): string {
  return `webauthn:chal:${ceremony}:${userId}`;
}

/** Stash the ceremony challenge for `userId` (overwrites any prior one for that ceremony), with a 5-min TTL. */
export async function storeWebauthnChallenge(
  ceremony: WebauthnCeremony,
  userId: string,
  challenge: string,
): Promise<void> {
  await redis().set(challengeKey(ceremony, userId), challenge, "EX", CHALLENGE_TTL_SECONDS);
}

/** Atomically CONSUME the pending challenge (GET+DEL — single-use): returns it, or null if none/expired. The
 *  verifier compares the returned value to the challenge echoed in the authenticator response. */
export async function consumeWebauthnChallenge(
  ceremony: WebauthnCeremony,
  userId: string,
): Promise<string | null> {
  return redis().getdel(challengeKey(ceremony, userId));
}
