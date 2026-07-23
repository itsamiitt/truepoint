// route.ts — POST /account/security/passkeys/register/options (AUTH-024). Returns the WebAuthn creation options
// (challenge + excludeCredentials) the browser passes to navigator.credentials.create. Gated on WEBAUTHN_ENABLED
// (404 when off) and authenticated (401 without a live session — the user is enrolling a passkey on their OWN
// account). The single-use challenge is stashed server-side by generatePasskeyRegistration for the verify step.
import { resolveApiUser } from "@/lib/requireUser";
import { generatePasskeyRegistration } from "@leadwolf/auth";
import { env } from "@leadwolf/config";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  if (env.WEBAUTHN_ENABLED !== "true") return new Response("Not found", { status: 404 });
  const account = await resolveApiUser();
  if (!account) return new Response("Unauthorized", { status: 401 });
  const options = await generatePasskeyRegistration({
    id: account.userId,
    email: account.user.email,
  });
  return Response.json(options);
}
