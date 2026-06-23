// route.ts — GET /orgs (Issue 2b): the organizations the signed-in user belongs to, for the app's org switcher.
// Cross-tenant BY NATURE, so it is served by the AUTH origin — whose privileged connection reads the membership
// graph (tenant_members by user_id) pre-tenant — and authenticated by the auth-origin refresh cookie. It is
// deliberately NOT on api.*, whose non-BYPASSRLS leadwolf_app role only ever sees the ACTIVE tenant (rls/auth.sql
// scopes tenant_members by the GUC), so a cross-tenant "my orgs" read there would return nothing. Returns each
// org plus the currently-active tenant id (from the session) so the switcher can mark the active one.
// Cross-origin, credentialed (CORS to app origins). A GET read of the caller's OWN memberships — no mutation.

import { REFRESH_COOKIE } from "@/lib/cookies";
import { corsHeaders } from "@/lib/cors";
import { hashRefreshToken } from "@leadwolf/auth";
import { sessionRepository, tenantMemberRepository } from "@leadwolf/db";

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

export async function GET(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);
  if (Object.keys(cors).length === 0) {
    return Response.json({ code: "forbidden" }, { status: 403 });
  }

  const presented = readRefreshCookie(req);
  if (!presented) {
    return Response.json({ code: "invalid_token" }, { status: 401, headers: cors });
  }

  const session = await sessionRepository.findByRefreshTokenHash(hashRefreshToken(presented));
  if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) {
    return Response.json({ code: "invalid_token" }, { status: 401, headers: cors });
  }

  const orgs = await tenantMemberRepository.listForUser(session.userId);
  return Response.json({ orgs, activeTenantId: session.tenantId ?? null }, { headers: cors });
}
