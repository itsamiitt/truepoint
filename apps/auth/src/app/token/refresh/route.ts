// route.ts — POST /token/refresh (ADR-0016): silent refresh. Reads the auth-origin refresh cookie (sent on
// same-site, credentialed fetches from the app), rotates the session, mints a fresh access JWT, and sets
// the rotated cookie. On any failure the cookie is cleared and 401 returned (reuse-detection upstream).

import {
  clearRefreshCookie,
  readRefreshTokenFromHeader,
  refreshCookie,
  shouldClearRefreshCookie,
} from "@/lib/cookies";
import { corsHeaders } from "@/lib/cors";
import { refreshAccessToken } from "@leadwolf/auth";
import { InvalidTokenError } from "@leadwolf/types";

const readRefreshCookie = (req: Request): string | null =>
  readRefreshTokenFromHeader(req.headers.get("cookie"));

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
  } catch (err) {
    const headers = new Headers(cors);
    // A concurrent rotation (another tab/app rotated this cookie moments ago) means the session is ALIVE and
    // the browser already holds the winner's rotated value — clearing would delete a working cookie, which is
    // how a routine two-app race became a browser-wide sign-out. Reject this request (still 401, so the
    // caller's silent-refresh recovery is unchanged) and leave the cookie alone; the next attempt sends the
    // winner's value and succeeds. shouldClearRefreshCookie carries the full reasoning and the other cases.
    //
    // Note this catch is broader than the switch routes': anything non-InvalidTokenError reaching here is an
    // infra fault, and clearing on those is the pre-existing behaviour, deliberately unchanged.
    if (!(err instanceof InvalidTokenError) || shouldClearRefreshCookie(err)) {
      for (const c of clearRefreshCookie()) headers.append("Set-Cookie", c);
    }
    return Response.json({ code: "invalid_token" }, { status: 401, headers });
  }
}
