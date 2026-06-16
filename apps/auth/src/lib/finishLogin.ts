import { type LoginTransaction, deleteLoginTransaction, finalizeLogin } from "@leadwolf/auth";
import { env } from "@leadwolf/config";
// finishLogin.ts — shared completion for the login flow: finalize the transaction (open the durable session
// + issue the cross-domain code), set the auth-origin refresh cookie, clear the login-transaction cookie,
// and redirect to the app callback. Called by whichever step reaches "complete" (password / MFA / workspace).
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { LOGIN_TXN_COOKIE, REFRESH_COOKIE } from "./cookies";

export async function finishLogin(txnId: string, txn: LoginTransaction): Promise<never> {
  const ua = (await headers()).get("user-agent") ?? undefined;
  const result = await finalizeLogin(txn, { userAgent: ua });
  await deleteLoginTransaction(txnId);

  const jar = await cookies();
  jar.set(REFRESH_COOKIE, result.refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    domain: env.AUTH_COOKIE_DOMAIN,
    maxAge: result.refreshMaxAge,
  });
  jar.delete(LOGIN_TXN_COOKIE);

  redirect(
    `${result.appOrigin}/auth/callback?code=${encodeURIComponent(result.code)}&state=${encodeURIComponent(result.state)}`,
  );
}
