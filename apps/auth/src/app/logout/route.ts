// route.ts — POST /logout (ADR-0016/0019): end the session on the auth origin. Reads the auth-origin refresh
// cookie (sent on same-site, credentialed fetches from the app), revokes the matching session, and ALWAYS
// clears the cookie. Idempotent: no cookie, or an unknown/already-revoked session, still clears + 204. Cross-
// origin, credentialed (CORS to app origins). Never throws into the response — logout must always succeed.

import { clearRefreshCookie, readRefreshTokenFromHeader } from "@/lib/cookies";
import { corsHeaders } from "@/lib/cors";
import { hashRefreshToken, revokeSession } from "@leadwolf/auth";
import { sessionRepository } from "@leadwolf/db";

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

  // Always clear the cookie and return 204, regardless of what we find — logout is idempotent and must
  // never reveal whether a session existed. The session revoke is best-effort and swallows any failure.
  const headers = new Headers(cors);
  for (const c of clearRefreshCookie()) headers.append("Set-Cookie", c);

  const presented = readRefreshCookie(req);
  if (presented) {
    try {
      const session = await sessionRepository.findByRefreshTokenHash(hashRefreshToken(presented));
      if (session && !session.revokedAt) await revokeSession(session.id);
    } catch {
      // Best-effort revoke (ADR-0031 §1): a DB hiccup must never block the user from logging out.
    }
  }

  return new Response(null, { status: 204, headers });
}
