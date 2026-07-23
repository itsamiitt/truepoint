// mailer.ts — the auth origin's transactional-email seam (verification codes, magic links, password reset).
// Delivery is a transport concern, so it lives in the app, not in packages/auth. Behaviour:
//   • dev/test (NODE_ENV !== production): log the message (incl. the code) to the console — no transport
//     needed locally, so the SSR flow is fully exercisable.
//   • production with a real SMTP_URL: deliver via nodemailer.
//   • production with SMTP_URL unset (AUTH-063): emit a stable, alertable ERROR marker and skip — never throw,
//     so no caller 500s (which on the reset flow would be an account-existence/timing oracle). The fix here is
//     operator VISIBILITY; the enumeration-safe uniform user response is unchanged.
//   • production pointed at a dev mail-CAPTURE tool like MailHog (AUTH-061): the mail is captured on-box and
//     never delivered — this was the real reason "forgot password is broken". Flag it LOUDLY on every send
//     (still hand it to the capture tool so a staging operator can inspect it). A real ESP must replace it.
// NOTE: this is the transport-visibility slice of the email hotfix. Moving the send onto a durable BullMQ
// queue (retry / DLQ / uniform-fast response that closes the AUTH-064 timing oracle) is the follow-up (0.2b).
import { env } from "@leadwolf/config";
import nodemailer, { type Transporter } from "nodemailer";
import { devCaptureHost } from "./mailTransport.ts";

export interface AuthEmail {
  to: string;
  subject: string;
  text: string;
  /** Optional branded HTML body; when present it rides as the primary part with `text` as the fallback. */
  html?: string;
}

const FROM = `TruePoint <no-reply@${new URL(env.AUTH_ORIGIN).hostname}>`;

let transporter: Transporter | undefined;
// Lazy so importing this module opens no socket (keeps `next build` side-effect-free).
// biome-ignore lint/suspicious/noAssignInExpressions: intentional lazy-singleton memoization (defer the socket).
const transport = (): Transporter => (transporter ??= nodemailer.createTransport(env.SMTP_URL));

export async function sendAuthEmail(message: AuthEmail): Promise<void> {
  if (env.NODE_ENV !== "production") {
    console.info(`[auth-mail] to=${message.to} subject="${message.subject}"\n${message.text}`);
    return;
  }
  if (!env.SMTP_URL) {
    // AUTH-063: was a soft stderr warn that read as success upstream. Emit a stable, greppable/alertable
    // marker instead. No recipient in the log (no PII).
    console.error(
      `[auth-mail] MISCONFIGURED transport_unset — email NOT sent subject="${message.subject}"`,
    );
    return;
  }
  const captureHost = devCaptureHost(env.SMTP_URL);
  if (captureHost) {
    // AUTH-061: production is pointed at a dev mail-capture tool (e.g. MailHog) — mail is captured on-box and
    // NOT delivered to the recipient. Flag every send loudly; still deliver to the capture tool below so a
    // staging/preview operator can inspect it. Replace with a real ESP (deploy/env.production.template).
    console.error(
      `[auth-mail] MISCONFIGURED transport_is_dev_capture host="${captureHost}" — mail captured, NOT delivered`,
    );
  }
  await transport().sendMail({
    from: FROM,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html, // undefined for any legacy text-only caller — nodemailer then sends text only.
  });
}
