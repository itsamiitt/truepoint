// code.ts — the single-use cross-domain authorization code (ADR-0016). 60-s TTL, IP-bound, PKCE-bound,
// origin-bound; held in Redis (not Postgres) for horizontal scale. GETDEL enforces single use atomically.

import { createHash, randomBytes } from "node:crypto";
import { env, isAllowedOrigin } from "@leadwolf/config";
import { type AuthCodeFailureReason, AuthInfraError, InvalidAuthCodeError } from "@leadwolf/types";
import Redis from "ioredis";
import { clientIpMatches } from "./ipBinding.ts";

// Lazy: constructing ioredis opens a socket + retry loop. Defer it so importing this module is
// side-effect-free (it's transpiled into the auth Next app; `next build` must not try to reach Redis).
let _redis: Redis | undefined;
// biome-ignore lint/suspicious/noAssignInExpressions: intentional lazy-singleton memoization (defer the socket).
const redis = (): Redis => (_redis ??= new Redis(env.REDIS_URL));
const key = (code: string) => `authcode:${code}`;

export interface CodeBinding {
  userId: string;
  tenantId: string;
  sessionId: string; // ties the minted access token's `sid` to the durable session (for revocation)
  appOrigin: string;
  clientIp: string;
  codeChallenge: string; // PKCE S256 challenge
  workspaceId?: string;
  isPlatformAdmin?: boolean; // platform super-admin flag, carried to the access-token `pa` claim (ADR-0032)
}

/** Mint a code bound to the session context; returned to the browser as a URL param on the redirect. */
export async function issueCode(binding: CodeBinding): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  await redis().set(key(code), JSON.stringify(binding), "EX", env.AUTH_CODE_TTL_SECONDS);
  return code;
}

const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/**
 * Pure validation of a consumed binding against the exchange request — no I/O, so it is unit-testable.
 * Returns the FIRST failing check (priority IP → origin → PKCE) as a diagnostic reason, or null when every
 * check passes. The reason names the failing check, never the offending value.
 */
export function validateBinding(
  binding: CodeBinding,
  args: { codeVerifier: string; clientIp: string; origin: string },
): AuthCodeFailureReason | null {
  if (!clientIpMatches(binding.clientIp, args.clientIp, env.AUTH_BIND_IP)) return "ip_mismatch";
  if (!isAllowedOrigin(args.origin) || binding.appOrigin !== args.origin) return "origin_mismatch";
  if (s256(args.codeVerifier) !== binding.codeChallenge) return "pkce_mismatch";
  return null;
}

/**
 * Validate + consume a code. Throws {@link InvalidAuthCodeError} (with a diagnostic reason) on a bad/expired
 * code, or {@link AuthInfraError} when the code STORE is unreachable — the caller maps the former to a 400
 * (client) and the latter to a 503 (server), so a Redis outage is never mislabeled as a bad client code.
 */
export async function exchangeCode(args: {
  code: string;
  codeVerifier: string;
  clientIp: string;
  origin: string;
}): Promise<CodeBinding> {
  let raw: string | null;
  try {
    raw = await redis().getdel(key(args.code)); // atomic single-use
  } catch {
    throw new AuthInfraError("redis_unavailable");
  }
  if (!raw) throw new InvalidAuthCodeError("code_not_found");

  const binding = JSON.parse(raw) as CodeBinding;
  const reason = validateBinding(binding, args);
  if (reason) throw new InvalidAuthCodeError(reason);

  return binding;
}
