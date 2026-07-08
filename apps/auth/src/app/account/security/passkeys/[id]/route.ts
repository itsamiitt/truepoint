// route.ts — DELETE /account/security/passkeys/[id] (AUTH-024): remove one of the authenticated user's passkeys.
// Gated on WEBAUTHN_ENABLED (404) + a live session (401). Ownership-checked in the repository (deleteForUser
// matches on userId AND id), so a foreign id deletes nothing → 404. Static /passkeys/register/* wins over this
// dynamic segment (Next first-match), so it only ever receives a credential id.
// STEP-UP: removing a login credential is a state-changing security action (a hijacked session could strip a
// user's passkeys), so it re-proves the current password/TOTP (stepUp.ts) — same as MFA disable. The credential
// rides in the request body (DELETE-with-body) so it never lands in a URL/log.
import { auditPasskeyChange } from "@/lib/auditPasskeyChange";
import { resolveApiUser } from "@/lib/requireUser";
import { env } from "@leadwolf/config";
import { webauthnCredentialRepository } from "@leadwolf/db";
import { verifyStepUp } from "../../stepUp";

export const dynamic = "force-dynamic";

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (env.WEBAUTHN_ENABLED !== "true") return new Response("Not found", { status: 404 });
  const account = await resolveApiUser();
  if (!account) return new Response("Unauthorized", { status: 401 });
  const body = (await req.json().catch(() => null)) as { stepUp?: string } | null;
  if (typeof body?.stepUp !== "string" || !(await verifyStepUp(account.user, body.stepUp))) {
    return Response.json({ error: "reauth" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const removed = await webauthnCredentialRepository.deleteForUser(account.userId, id);
  if (removed > 0) await auditPasskeyChange(account.userId, "passkey.remove");
  return new Response(null, { status: removed > 0 ? 204 : 404 });
}
