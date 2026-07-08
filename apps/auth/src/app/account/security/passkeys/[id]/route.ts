// route.ts — DELETE /account/security/passkeys/[id] (AUTH-024): remove one of the authenticated user's passkeys.
// Gated on WEBAUTHN_ENABLED (404) + a live session (401). Ownership-checked in the repository (deleteForUser
// matches on userId AND id), so a foreign id deletes nothing → 404. Static /passkeys/register/* wins over this
// dynamic segment (Next first-match), so it only ever receives a credential id.
import { resolveApiUser } from "@/lib/requireUser";
import { env } from "@leadwolf/config";
import { webauthnCredentialRepository } from "@leadwolf/db";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (env.WEBAUTHN_ENABLED !== "true") return new Response("Not found", { status: 404 });
  const account = await resolveApiUser();
  if (!account) return new Response("Unauthorized", { status: 401 });
  const { id } = await ctx.params;
  const removed = await webauthnCredentialRepository.deleteForUser(account.userId, id);
  return new Response(null, { status: removed > 0 ? 204 : 404 });
}
