// route.ts — POST /token/refresh (ADR-0016): silent refresh. Reads the auth-origin refresh cookie (sent on
// same-site, credentialed fetches from the app), rotates the session, mints a fresh access JWT, and sets
// the rotated cookie. On any failure the cookie is cleared and 401 returned (reuse-detection upstream).

import { refreshAccessToken } from "@leadwolf/auth";
import { REFRESH_COOKIE, clearRefreshCookie, refreshCookie } from "@/lib/cookies";
import { corsHeaders } from "@/lib/cors";

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

  const presented = readRefreshCookie(req);
  if (!presented) {
    return Response.json({ code: "invalid_token" }, { status: 401, headers: cors });
  }

  try {
    const result = await refreshAccessToken({
      presentedRefreshToken: presented,
      audience: origin as string,
    });
    const headers = new Headers(cors);
    headers.append("Set-Cookie", refreshCookie(result.refreshToken, result.refreshMaxAge));
    return Response.json(
      { accessToken: result.accessToken, tokenType: "Bearer", expiresIn: result.expiresIn },
      { headers },
    );
  } catch {
    const headers = new Headers(cors);
    headers.append("Set-Cookie", clearRefreshCookie());
    return Response.json({ code: "invalid_token" }, { status: 401, headers });
  }
}
