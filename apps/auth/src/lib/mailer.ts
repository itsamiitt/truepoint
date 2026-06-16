// mailer.ts — the auth origin's transactional-email seam (verification codes, magic links). Delivery is a
// transport concern, so it lives in the app, not in packages/auth. Behaviour:
//   • dev/test (NODE_ENV !== production): log the message (incl. the code) to the console — no transport
//     needed locally, so the SSR flow is fully exercisable.
//   • production with SMTP_URL set: deliver via nodemailer (the preview stack points SMTP_URL at MailHog,
//     smtp://mailhog:1025 — view captured mail over the SSH tunnel).
//   • production with SMTP_URL unset: log + warn rather than throw, so signup never 500s on a missing
//     transport (you just won't get the email until SMTP_URL is configured).
import { env } from "@leadwolf/config";
import nodemailer, { type Transporter } from "nodemailer";

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
    process.stderr.write(
      `[auth-mail] SMTP_URL not set — email NOT sent. to=${message.to} subject="${message.subject}"\n`,
    );
    return;
  }
  await transport().sendMail({
    from: FROM,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html, // undefined for any legacy text-only caller — nodemailer then sends text only.
  });
}
