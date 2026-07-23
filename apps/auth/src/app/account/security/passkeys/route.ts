// route.ts — GET /account/security/passkeys (AUTH-024): the authenticated user's passkeys as a UI summary (no
// public key). Gated on WEBAUTHN_ENABLED (404) + a live session (401). Read-only; the account "your passkeys"
// list fetches this.
import { resolveApiUser } from "@/lib/requireUser";
import { env } from "@leadwolf/config";
import { webauthnCredentialRepository } from "@leadwolf/db";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  if (env.WEBAUTHN_ENABLED !== "true") return new Response("Not found", { status: 404 });
  const account = await resolveApiUser();
  if (!account) return new Response("Unauthorized", { status: 401 });
  const passkeys = await webauthnCredentialRepository.listSummaryForUser(account.userId);
  return Response.json({ passkeys });
}
