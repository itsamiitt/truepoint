// route.ts — POST /mfa/passkey/options (AUTH-024): a passkey authentication challenge for the user in the PENDING
// login transaction (they've passed the first factor; passkey is the second). Restricted to that user's
// credentials. Gated on WEBAUTHN_ENABLED (404) + a live login transaction (401). The single-use challenge is
// stashed server-side by generatePasskeyAuthentication for the verify step (submitMfaPasskey).
import { LOGIN_TXN_COOKIE } from "@/lib/cookies";
import { generatePasskeyAuthentication, getLoginTransaction } from "@leadwolf/auth";
import { env } from "@leadwolf/config";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  if (env.WEBAUTHN_ENABLED !== "true") return new Response("Not found", { status: 404 });
  const txnId = (await cookies()).get(LOGIN_TXN_COOKIE)?.value;
  if (!txnId) return new Response("Unauthorized", { status: 401 });
  const txn = await getLoginTransaction(txnId);
  if (!txn) return new Response("Unauthorized", { status: 401 });
  const options = await generatePasskeyAuthentication(txn.userId);
  return Response.json(options);
}
