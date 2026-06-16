// passwordReset.ts — the password-reset email (17 §9). A single ink CTA to the one-click /reset link plus a
// copy-paste fallback. Branded HTML + plaintext fallback. Enumeration-safe: only sent when the account exists.
import { type RenderedEmail, emailButton, rawLink, renderHtml, renderText } from "./layout.ts";

export interface PasswordResetInput {
  link: string;
  expiresMinutes?: number;
}

export function passwordResetEmail({
  link,
  expiresMinutes = 15,
}: PasswordResetInput): RenderedEmail {
  const bodyHtml = `<p style="margin:0 0 18px;">Click the button below to choose a new password. This link expires in ${expiresMinutes} minutes and can be used once.</p>${emailButton(link, "Reset password")}${rawLink(link)}<p style="margin:16px 0 0;color:#6b7280;font-size:13px;">If you didn't request this, your account is still secure — you can safely ignore this email.</p>`;
  const text = `Reset your TruePoint password using this link (expires in ${expiresMinutes} minutes, single use):\n\n${link}\n\nIf you didn't request this, your account is still secure — you can safely ignore this email.`;
  return {
    subject: "Reset your TruePoint password",
    html: renderHtml({
      previewText: `Reset your password (link expires in ${expiresMinutes} minutes)`,
      heading: "Reset your password",
      bodyHtml,
    }),
    text: renderText(text),
  };
}
