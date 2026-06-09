// code.ts — the single-use cross-domain authorization code (ADR-0016). 60-s TTL, IP-bound, PKCE-bound,
// origin-bound; held in Redis (not Postgres) for horizontal scale. GETDEL enforces single use atomically.

import { createHash, randomBytes } from "node:crypto";
import Redis from "ioredis";
import { env, isAllowedOrigin } from "@leadwolf/config";
import { InvalidAuthCodeError } from "@leadwolf/types";

const redis = new Redis(env.REDIS_URL);
const key = (code: string) => `authcode:${code}`;

export interface CodeBinding {
  userId: string;
  tenantId: string;
  sessionId: string; // ties the minted access token's `sid` to the durable session (for revocation)
  appOrigin: string;
  clientIp: string;
  codeChallenge: string; // PKCE S256 challenge
  workspaceId?: string;
}

/** Mint a code bound to the session context; returned to the browser as a URL param on the redirect. */
export async function issueCode(binding: CodeBinding): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  await redis.set(key(code), JSON.stringify(binding), "EX", env.AUTH_CODE_TTL_SECONDS);
  return code;
}

const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** Validate + consume a code. Throws InvalidAuthCodeError on any mismatch (single-use, IP, PKCE, origin). */
export async function exchangeCode(args: {
  code: string;
  codeVerifier: string;
  clientIp: string;
  origin: string;
}): Promise<CodeBinding> {
  const raw = await redis.getdel(key(args.code)); // atomic single-use
  if (!raw) throw new InvalidAuthCodeError();

  const binding = JSON.parse(raw) as CodeBinding;
  const okIp = binding.clientIp === args.clientIp;
  const okOrigin = isAllowedOrigin(args.origin) && binding.appOrigin === args.origin;
  const okPkce = s256(args.codeVerifier) === binding.codeChallenge;
  if (!okIp || !okOrigin || !okPkce) throw new InvalidAuthCodeError();

  return binding;
}
