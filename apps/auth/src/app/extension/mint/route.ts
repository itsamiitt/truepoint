// route.ts — POST /auth/extension/mint (ADR-0045 / chrome-extension doc 12 §8). The `/auth/extension`
// handoff page (app origin, credentialed) calls this to mint an EXTENSION-SCOPED token family for the
// CURRENTLY signed-in user, then hands it to the extension via chrome.runtime.sendMessage. It reuses the
// proven session primitives: resolve the user from the durable lw_refresh cookie (same durable-session
// lookup as refresh/logout/requireUser), create a SEPARATE session family (a distinct device — independently
// revocable), and mint an access JWT whose `aud` is the extension origin. NEVER hands out the web session's
// own token/cookie. Cross-origin credentialed (CORS to the app origin); the extension id must be registered
// in EXTENSION_ORIGINS (off by default) — fail closed otherwise.
//
// SECURITY: mints ONLY for the user proven by the cookie (never an id from the body); the target audience is
// validated against the server allow-list; a platform-admin bit is deliberately NOT carried into the
// extension token (a scoped prospecting credential, not an admin one).
import { clientIp } from "@/lib/clientIp";
import { REFRESH_COOKIE } from "@/lib/cookies";
import { corsHeaders } from "@/lib/cors";
import { createSession, hashRefreshToken, mintAccessToken, recordAuthEvent } from "@leadwolf/auth";
import { isAllowedOrigin } from "@leadwolf/config";
import { sessionRepository, userRepository } from "@leadwolf/db";

const EXT_ID_RE = /^[a-p]{32}$/;

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

  const body = (await req.json().catch(() => null)) as { extId?: unknown } | null;
  const extId = typeof body?.extId === "string" ? body.extId : "";
  if (!EXT_ID_RE.test(extId)) {
    return Response.json({ code: "validation_error" }, { status: 422, headers: cors });
  }
  const extOrigin = `chrome-extension://${extId}`;
  if (!isAllowedOrigin(extOrigin)) {
    return Response.json({ code: "extension_not_registered" }, { status: 403, headers: cors });
  }

  // Resolve the CURRENT signed-in user from the durable session cookie (inline requireUser — a route returns
  // 401 rather than redirecting). A merely-present cookie never counts: the session must be unrevoked + unexpired.
  const cookieToken = readRefreshCookie(req);
  if (!cookieToken) {
    return Response.json({ code: "invalid_token" }, { status: 401, headers: cors });
  }
  const session = await sessionRepository.findByRefreshTokenHash(hashRefreshToken(cookieToken));
  if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
    return Response.json({ code: "invalid_token" }, { status: 401, headers: cors });
  }
  const user = await userRepository.findById(session.userId);
  if (!user || user.status !== "active") {
    return Response.json({ code: "invalid_token" }, { status: 401, headers: cors });
  }
  if (!session.tenantId) {
    // An extension token must be tenant-scoped; the user needs an active org first.
    return Response.json({ code: "no_active_org" }, { status: 409, headers: cors });
  }

  const ip = clientIp(req);
  const userAgent = req.headers.get("user-agent");
  try {
    const issued = await createSession({
      userId: session.userId,
      tenantId: session.tenantId,
      workspaceId: session.workspaceId ?? undefined,
      appOrigin: extOrigin,
      ipAddress: ip,
      userAgent: userAgent ?? undefined,
    });
    const minted = await mintAccessToken({
      userId: session.userId,
      tenantId: session.tenantId,
      workspaceId: session.workspaceId ?? undefined,
      sessionId: issued.sessionId,
      audience: extOrigin,
      scope: ["extension"],
    });
    void recordAuthEvent({
      tenantId: session.tenantId,
      workspaceId: session.workspaceId ?? null,
      actorUserId: session.userId,
      entityType: "user",
      entityId: session.userId,
      metadata: { sessionId: issued.sessionId },
      ipAddress: ip,
      userAgent,
      originDomain: origin,
      action: "token.issued",
    });
    return Response.json(
      {
        accessToken: minted.token,
        tokenType: "Bearer",
        expiresIn: minted.expiresIn,
        refreshToken: issued.refreshToken,
      },
      { headers: cors },
    );
  } catch {
    return Response.json({ code: "auth_unavailable" }, { status: 503, headers: cors });
  }
}
