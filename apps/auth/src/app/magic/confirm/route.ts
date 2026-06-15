// route.ts — the one-click magic-link callback (auth.truepoint.in/magic/confirm, 17 §2/§9). The emailed link
// lands here with `email` + `code`; we consume the single-use code (purpose magic_link), recover the app's
// PKCE/return context from the hardened MAGIC_TXN_COOKIE, then completeMagic finalizes the login (durable
// session + cross-domain code) and redirects. A bad/expired code or missing txn bounces back to /login with
// the app's context preserved — never a blank error. A Route Handler because it must set cookies.
import { clientIpFromHeaders } from "@/lib/clientIp";
import { completeMagic } from "@/lib/completeMagic";
import { clearMagicTxnCookie, readMagicTxnCookie } from "@/lib/cookies";
import { decodeMagicCarry } from "@/lib/magicCarry";
import { verifyEmailCode } from "@leadwolf/auth";
import { redirect } from "next/navigation";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
  const code = (url.searchParams.get("code") ?? "").trim();

  // Recover the app's context from the cookie so any failure can bounce cleanly back to /login.
  const carry = decodeMagicCarry(await readMagicTxnCookie());
  const loginCarry = new URLSearchParams({
    app_origin: carry?.appOrigin ?? "",
    code_challenge: carry?.codeChallenge ?? "",
    state: carry?.state ?? "",
  });
  const fail = (): never => redirect(`/login?${loginCarry.toString()}&error=magic`);

  if (!email || !code || !carry) {
    await clearMagicTxnCookie();
    return fail();
  }

  if (!(await verifyEmailCode({ email, code, purpose: "magic_link" }))) {
    await clearMagicTxnCookie();
    return fail();
  }

  // completeMagic clears the magic cookie, sets the login-transaction cookie, and always redirects.
  const clientIp = clientIpFromHeaders(request.headers);
  await completeMagic(email, { ...carry, clientIp });
  return new Response(null, { status: 302 }); // unreachable: completeMagic always redirects
}
