// route.ts — POST /auth/extension/logout (ADR-0045). Revokes the extension's session family given its
// rotating refresh token in the body. Idempotent, best-effort, always 204 (mirrors /auth/logout, but
// body-based — no cookie to clear on the SW side).
import { corsHeaders } from "@/lib/cors";
import { hashRefreshToken, revokeSession } from "@leadwolf/auth";
import { sessionRepository } from "@leadwolf/db";

export async function OPTIONS(req: Request): Promise<Response> {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

export async function POST(req: Request): Promise<Response> {
  const cors = corsHeaders(req.headers.get("origin"));
  if (Object.keys(cors).length === 0) {
    return Response.json({ code: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { refreshToken?: unknown } | null;
  const refreshToken = typeof body?.refreshToken === "string" ? body.refreshToken : "";
  if (refreshToken) {
    try {
      const session = await sessionRepository.findByRefreshTokenHash(
        hashRefreshToken(refreshToken),
      );
      if (session && !session.revokedAt) {
        await revokeSession(session.id);
      }
    } catch {
      // best-effort — logout never fails
    }
  }
  return new Response(null, { status: 204, headers: cors });
}
