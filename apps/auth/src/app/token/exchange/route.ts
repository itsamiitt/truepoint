// route.ts — POST /token/exchange (ADR-0016): the app domain swaps a single-use 60-s code (+PKCE verifier)
// for a short-lived access JWT. The code is validated server-side (single-use, IP, PKCE, allow-listed
// origin) BEFORE any token is minted; tokens never appear in URLs. Cross-origin, credentialed (CORS).
//
// Failures are kept DISTINCT (a bad client code is not a server outage): a failed code validation → 400
// `invalid_auth_code` + a diagnostic `reason`; the code store being unreachable or token signing failing →
// 503 `auth_unavailable` with the reason in the SERVER LOG only. Audit writes are best-effort (they swallow
// internally) and never gate token issuance. We never log the code, verifier, token, or raw client IP.

import { clientIp } from "@/lib/clientIp";
import { corsHeaders } from "@/lib/cors";
import { exchangeCode, log, mintAccessToken, recordAuthEvent } from "@leadwolf/auth";
import {
  type AuthCodeFailureReason,
  AuthInfraError,
  InvalidAuthCodeError,
  tokenExchangeSchema,
} from "@leadwolf/types";

export async function OPTIONS(req: Request): Promise<Response> {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

export async function POST(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);
  if (Object.keys(cors).length === 0) {
    return Response.json({ code: "forbidden" }, { status: 403 });
  }

  const parsed = tokenExchangeSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ code: "validation_error" }, { status: 422, headers: cors });
  }

  const ip = clientIp(req);

  // 1. Validate + consume the single-use code. A bad/expired/replayed code is a CLIENT error (400 + the
  //    failing check); an unreachable code store is a SERVER fault (503) — never conflate the two.
  let binding: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    binding = await exchangeCode({
      code: parsed.data.code,
      codeVerifier: parsed.data.codeVerifier,
      clientIp: ip,
      origin: origin as string,
    });
  } catch (err) {
    if (err instanceof InvalidAuthCodeError) {
      const reason = err.extensions.reason as AuthCodeFailureReason | undefined;
      log.warn("token.exchange.invalid_code", { reason, originDomain: origin });
      return Response.json(
        { code: err.code, ...(reason ? { reason } : {}) },
        { status: err.status, headers: cors },
      );
    }
    const reason = err instanceof AuthInfraError ? err.reason : "unknown";
    log.error("token.exchange.infra_error", { reason, originDomain: origin });
    return Response.json({ code: "auth_unavailable" }, { status: 503, headers: cors });
  }

  // code.exchanged — the single-use code was consumed + validated (ADR-0031 §2). Best-effort; never the code.
  await recordAuthEvent({
    tenantId: binding.tenantId,
    workspaceId: binding.workspaceId ?? null,
    actorUserId: binding.userId,
    action: "code.exchanged",
    entityType: "user",
    entityId: binding.userId,
    metadata: { sessionId: binding.sessionId },
    ipAddress: ip,
    userAgent: req.headers.get("user-agent"),
    originDomain: origin,
  });

  // 2. Mint the access JWT. A signing failure (missing/garbled key, KID) is a SERVER fault, NOT a bad code —
  //    surface it as 503 (don't invite the client to "retry with a better code"); log the reason only.
  let minted: Awaited<ReturnType<typeof mintAccessToken>>;
  try {
    minted = await mintAccessToken({
      userId: binding.userId,
      tenantId: binding.tenantId,
      workspaceId: binding.workspaceId,
      sessionId: binding.sessionId,
      audience: origin as string,
      isPlatformAdmin: binding.isPlatformAdmin,
    });
  } catch (err) {
    log.error("token.exchange.mint_failed", {
      reason: "token_mint_failed",
      err: err instanceof Error ? err.name : "unknown",
    });
    return Response.json({ code: "auth_unavailable" }, { status: 503, headers: cors });
  }

  // token.issued — an access JWT was minted (ADR-0031 §2). Best-effort; never the token string.
  await recordAuthEvent({
    tenantId: binding.tenantId,
    workspaceId: binding.workspaceId ?? null,
    actorUserId: binding.userId,
    action: "token.issued",
    entityType: "user",
    entityId: binding.userId,
    metadata: { sessionId: binding.sessionId },
    ipAddress: ip,
    userAgent: req.headers.get("user-agent"),
    originDomain: origin,
  });

  return Response.json(
    { accessToken: minted.token, tokenType: "Bearer", expiresIn: minted.expiresIn },
    { headers: cors },
  );
}
