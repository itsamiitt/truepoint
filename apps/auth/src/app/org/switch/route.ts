// route.ts — POST /org/switch (ADR-0019 follow-up, Issue 2b): an authenticated multi-org user re-pins their
// active ORGANIZATION (tenant) without logging out. Reads the auth-origin refresh cookie (same-site,
// credentialed), authorizes the target tenant against the user's active memberships, lands them on that org's
// remembered/default workspace, rotates the session, and mints a fresh access JWT carrying the new tid/wid —
// returning the rotated cookie. A bad/expired session → 401 (cookie cleared, reuse-rejection upstream); a
// tenant the user may not access → 403 (the session stays valid). Cross-origin, credentialed (CORS to apps).
// Mirrors workspace/switch/route.ts.

import { REFRESH_COOKIE, clearRefreshCookie, refreshCookie } from "@/lib/cookies";
import { corsHeaders } from "@/lib/cors";
import { switchOrg } from "@leadwolf/auth";
import { AppError, InvalidTokenError, orgSelectionSchema } from "@leadwolf/types";

function readRefreshCookie(req: Request): string | null {
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === REFRESH_COOKIE) return v.join("=");
  }
  return null;
}

export async function OPTIONS(req: Request): Promise<Response> {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

export async function POST(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);
  if (Object.keys(cors).length === 0) {
    return Response.json({ code: "forbidden" }, { status: 403 });
  }

  const parsed = orgSelectionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ code: "validation_error" }, { status: 422, headers: cors });
  }

  const presented = readRefreshCookie(req);
  if (!presented) {
    return Response.json({ code: "invalid_token" }, { status: 401, headers: cors });
  }

  try {
    const result = await switchOrg({
      presentedRefreshToken: presented,
      targetTenantId: parsed.data.tenantId,
      audience: origin as string,
    });
    const headers = new Headers(cors);
    headers.append("Set-Cookie", refreshCookie(result.refreshToken, result.refreshMaxAge));
    return Response.json(
      { accessToken: result.accessToken, tokenType: "Bearer", expiresIn: result.expiresIn },
      { headers },
    );
  } catch (err) {
    const headers = new Headers(cors);
    // Only an invalid/expired session clears the cookie (reuse-rejection); a 403 (no access to the target org)
    // leaves the still-valid session intact so the user keeps their current org.
    if (err instanceof InvalidTokenError)
      for (const c of clearRefreshCookie()) headers.append("Set-Cookie", c);
    const status = err instanceof AppError ? err.status : 401;
    const code = err instanceof AppError ? err.code : "invalid_token";
    return Response.json({ code }, { status, headers });
  }
}
