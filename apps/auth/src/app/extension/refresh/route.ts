// route.ts — POST /auth/extension/refresh (ADR-0045). The extension service worker calls this with its
// rotating refresh token IN THE BODY (no cookie — the SW holds the token in chrome.storage.session). Mirrors
// /token/refresh but body-based, and returns the rotated refresh token in the JSON body (no Set-Cookie). An
// optional workspaceId/tenantId re-scopes via the same switch primitives the web app uses. `aud` = the
// extension origin so apps/api accepts the token (it must be in EXTENSION_ORIGINS ⊂ appOrigins()).
import { corsHeaders } from "@/lib/cors";
import { refreshAccessToken, switchOrg, switchWorkspace } from "@leadwolf/auth";
import { AppError, InvalidTokenError } from "@leadwolf/types";

export async function OPTIONS(req: Request): Promise<Response> {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

export async function POST(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);
  if (Object.keys(cors).length === 0) {
    return Response.json({ code: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as {
    refreshToken?: unknown;
    workspaceId?: unknown;
    tenantId?: unknown;
  } | null;
  const refreshToken = typeof body?.refreshToken === "string" ? body.refreshToken : "";
  if (!refreshToken) {
    return Response.json({ code: "validation_error" }, { status: 422, headers: cors });
  }

  try {
    const audience = origin as string;
    let result: { accessToken: string; expiresIn: number; refreshToken: string };
    if (typeof body?.workspaceId === "string") {
      result = await switchWorkspace({
        presentedRefreshToken: refreshToken,
        targetWorkspaceId: body.workspaceId,
        audience,
      });
    } else if (typeof body?.tenantId === "string") {
      result = await switchOrg({
        presentedRefreshToken: refreshToken,
        targetTenantId: body.tenantId,
        audience,
      });
    } else {
      result = await refreshAccessToken({ presentedRefreshToken: refreshToken, audience });
    }
    return Response.json(
      {
        accessToken: result.accessToken,
        tokenType: "Bearer",
        expiresIn: result.expiresIn,
        refreshToken: result.refreshToken,
      },
      { headers: cors },
    );
  } catch (err) {
    if (err instanceof InvalidTokenError) {
      return Response.json({ code: "invalid_token" }, { status: 401, headers: cors });
    }
    // A scope error (e.g. workspace the user can't access) is a 403 that leaves the session intact.
    const status = err instanceof AppError ? err.status : 503;
    const code = err instanceof AppError ? err.code : "auth_unavailable";
    return Response.json({ code }, { status, headers: cors });
  }
}
