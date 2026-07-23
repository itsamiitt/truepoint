// notifyPasskeyChange.ts — fire the passkey security-notification email to the account's OWN address (AUTH-024),
// detached + best-effort so it never delays or breaks the passkey route (mirrors notifyMfaChanged). The "if this
// wasn't you" CTA points at the forgot-password flow (the strongest re-secure lever). Carries no secret.
import { authUrl } from "@/lib/authUrl";
import { passkeyChangedEmail } from "@/lib/emails";
import { sendAuthEmail } from "@/lib/mailer";
import { env } from "@leadwolf/config";

export function notifyPasskeyChange(email: string, change: "added" | "removed"): void {
  const secureUrl = authUrl(env.AUTH_ORIGIN, "/forgot");
  void sendAuthEmail({ to: email, ...passkeyChangedEmail({ change, secureUrl }) }).catch((e) =>
    console.error(
      "[auth-mail] passkey-changed notification failed:",
      e instanceof Error ? e.message : e,
    ),
  );
}
