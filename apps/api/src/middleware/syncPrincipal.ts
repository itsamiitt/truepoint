// syncPrincipal.ts — the machine-only auth gate for POST /api/v1/master-sync (docs/planning/forge/11 §4,
// ADR-0047; G-FORGE-1102). This is NOT the human authn→tenancy→requireRole chain (ingest/routes.ts): the caller
// is TruePoint Forge presenting a client-credentials service JWT (aud=truepoint-api, scope∋master-sync), never a
// user/tenant session. We verify the token's signature + issuer + audience, then require the master-sync scope.
// mTLS + short rotation are layered by infra (14-security). Contrast: authn.ts verifies aud=app-origins.
import { verifyAccessToken } from "@leadwolf/auth";
import { ForbiddenError, InvalidTokenError } from "@leadwolf/types";
import type { Context, Next } from "hono";

const SYNC_AUDIENCE = "truepoint-api";
const SYNC_SCOPE = "master-sync";

/** The verified machine subject the master-sync routes read (for audit/log). */
export type SyncPrincipalVariables = { syncSubject: string };

export async function syncPrincipal(
  c: Context<{ Variables: SyncPrincipalVariables }>,
  next: Next,
): Promise<void> {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw new InvalidTokenError();

  let scope: string[];
  let sub: string;
  try {
    const claims = await verifyAccessToken(token, SYNC_AUDIENCE);
    scope = claims.scope;
    sub = claims.sub;
  } catch {
    throw new InvalidTokenError(); // bad signature / issuer / audience / expiry — never reveal which
  }

  if (!scope.includes(SYNC_SCOPE)) {
    throw new ForbiddenError("insufficient_scope", "the master-sync scope is required");
  }
  c.set("syncSubject", sub);
  await next();
}
