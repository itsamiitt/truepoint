// route.ts — POST /account/security/passkeys/register/verify (AUTH-024). Verifies the attestation the browser
// returned from navigator.credentials.create against the stashed single-use challenge, and (on success) stores
// the credential for the authenticated user. Gated on WEBAUTHN_ENABLED (404) + a live session (401). Fails
// closed: verifyPasskeyRegistration returns false on a missing/expired challenge or any verification error.
import { resolveApiUser } from "@/lib/requireUser";
import { type RegistrationResponseJSON, verifyPasskeyRegistration } from "@leadwolf/auth";
import { env } from "@leadwolf/config";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (env.WEBAUTHN_ENABLED !== "true") return new Response("Not found", { status: 404 });
  const account = await resolveApiUser();
  if (!account) return new Response("Unauthorized", { status: 401 });
  const body = (await req.json().catch(() => null)) as {
    response?: RegistrationResponseJSON;
    label?: string;
  } | null;
  if (!body?.response) return new Response("Bad request", { status: 400 });
  const verified = await verifyPasskeyRegistration(
    { id: account.userId },
    body.response,
    typeof body.label === "string" ? body.label.slice(0, 100) : undefined,
  );
  return Response.json({ verified }, { status: verified ? 200 : 400 });
}
