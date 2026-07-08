import { type LoginTransaction, deleteLoginTransaction, finalizeLogin } from "@leadwolf/auth";
import { env } from "@leadwolf/config";
// finishLogin.ts — shared completion for the login flow: finalize the transaction (open the durable session
// + issue the cross-domain code), set the auth-origin refresh cookie, clear the login-transaction cookie,
// and redirect to the app callback. Called by whichever step reaches "complete" (password / MFA / workspace).
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { LOGIN_TXN_COOKIE, refreshCookieName, refreshCookieWritesHost } from "./cookies";

export async function finishLogin(txnId: string, txn: LoginTransaction): Promise<never> {
  const ua = (await headers()).get("user-agent") ?? undefined;
  const result = await finalizeLogin(txn, { userAgent: ua });
  await deleteLoginTransaction(txnId);

  const jar = await cookies();
  // AUTH-074: under the __Host- write flip the cookie MUST carry no Domain (browser-enforced host-only); the
  // legacy cookie keeps its host-scoped Domain. Readers already accept both names (dual-read stage).
  jar.set(refreshCookieName(), result.refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    ...(refreshCookieWritesHost() ? {} : { domain: env.AUTH_COOKIE_DOMAIN }),
    maxAge: result.refreshMaxAge,
  });
  jar.delete(LOGIN_TXN_COOKIE);

  redirect(
    `${result.appOrigin}/auth/callback?code=${encodeURIComponent(result.code)}&state=${encodeURIComponent(result.state)}`,
  );
}
