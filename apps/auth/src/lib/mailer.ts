// mailer.ts — the auth origin's transactional-email seam (verification codes, magic links). Delivery is a
// transport concern, so it lives in the app, not in packages/auth. This is a swappable seam (mirrors the
// KMS-swappable encryptPii pattern): with no SMTP configured it logs to the server console so the SSR flow
// is fully exercisable in dev; wiring `SMTP_URL` to a real transport (e.g. nodemailer) is the prod swap-in.
import { env } from "@leadwolf/config";

export interface AuthEmail {
  to: string;
  subject: string;
  text: string;
}

export async function sendAuthEmail(message: AuthEmail): Promise<void> {
  if (!env.SMTP_URL || env.NODE_ENV !== "production") {
    // Dev/test: surface the message (incl. the code) in logs instead of sending it.
    console.info(`[auth-mail] to=${message.to} subject="${message.subject}"\n${message.text}`);
    return;
  }
  // Production transport seam: connect to env.SMTP_URL and deliver. Intentionally not wired to a concrete
  // SMTP client here (no transport dependency is vendored yet); failing loudly beats silently dropping mail.
  throw new Error("SMTP delivery is not configured: wire a transport to env.SMTP_URL");
}
