// route.ts — POST /token/exchange (ADR-0016): the app domain swaps a single-use 60-s code (+PKCE verifier)
// for a short-lived access JWT. The code is validated server-side (single-use, IP, PKCE, allow-listed
// origin) BEFORE any token is minted; tokens never appear in URLs. Cross-origin, credentialed (CORS).

import { clientIp } from "@/lib/clientIp";
import { corsHeaders } from "@/lib/cors";
import { exchangeCode, mintAccessToken, recordAuthEvent } from "@leadwolf/auth";
import { tokenExchangeSchema } from "@leadwolf/types";

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

  try {
    const binding = await exchangeCode({
      code: parsed.data.code,
      codeVerifier: parsed.data.codeVerifier,
      clientIp: clientIp(req),
      origin: origin as string,
    });
    // code.exchanged — the single-use code was consumed + validated (ADR-0031 §2). Never log the code.
    await recordAuthEvent({
      tenantId: binding.tenantId,
      workspaceId: binding.workspaceId ?? null,
      actorUserId: binding.userId,
      action: "code.exchanged",
      entityType: "user",
      entityId: binding.userId,
      metadata: { sessionId: binding.sessionId },
      ipAddress: clientIp(req),
      userAgent: req.headers.get("user-agent"),
      originDomain: origin,
    });
    const { token, expiresIn } = await mintAccessToken({
      userId: binding.userId,
      tenantId: binding.tenantId,
      workspaceId: binding.workspaceId,
      sessionId: binding.sessionId,
      audience: origin as string,
    });
    // token.issued — an access JWT was minted (ADR-0031 §2). Never log the token string.
    await recordAuthEvent({
      tenantId: binding.tenantId,
      workspaceId: binding.workspaceId ?? null,
      actorUserId: binding.userId,
      action: "token.issued",
      entityType: "user",
      entityId: binding.userId,
      metadata: { sessionId: binding.sessionId },
      ipAddress: clientIp(req),
      userAgent: req.headers.get("user-agent"),
      originDomain: origin,
    });
    return Response.json({ accessToken: token, tokenType: "Bearer", expiresIn }, { headers: cors });
  } catch {
    return Response.json({ code: "invalid_auth_code" }, { status: 400, headers: cors });
  }
}
