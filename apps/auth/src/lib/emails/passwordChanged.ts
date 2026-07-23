// passwordChanged.ts — a SECURITY-NOTIFICATION email (AUTH-067): sent to the account email AFTER the password
// is changed (self-service change in /account/security, or a completed forgot-password reset) so that an
// UNAUTHORIZED change is noticed by the real owner. Unlike the reset/magic mails this carries no secret and is
// not enumeration-relevant — the account definitely exists, because the change just happened. A single "if this
// wasn't you" CTA re-secures the account (a link into the forgot-password flow). Branded HTML + plaintext.
import { type RenderedEmail, emailButton, rawLink, renderHtml, renderText } from "./layout.ts";

export interface PasswordChangedInput {
  /** Link into the re-secure (forgot-password) flow, shown under "If this wasn't you". Omitted → no CTA button. */
  secureUrl?: string;
}

export function passwordChangedEmail({ secureUrl }: PasswordChangedInput = {}): RenderedEmail {
  const cta = secureUrl
    ? `${emailButton(secureUrl, "Secure your account")}${rawLink(secureUrl)}`
    : "";
  const bodyHtml = `<p style="margin:0 0 16px;">Your TruePoint account password was just changed. If you made this change, no action is needed.</p><p style="margin:0 0 18px;">If you didn't change it, your account may be at risk — reset your password now and review your active sessions.</p>${cta}`;
  const secureText = secureUrl ? `\n\nReset your password now: ${secureUrl}` : "";
  const text = `Your TruePoint account password was just changed.\n\nIf you made this change, no action is needed. If you didn't change it, your account may be at risk — reset your password now and review your active sessions.${secureText}`;
  return {
    subject: "Your TruePoint password was changed",
    html: renderHtml({
      previewText: "Your TruePoint password was just changed",
      heading: "Your password was changed",
      bodyHtml,
    }),
    text: renderText(text),
  };
}
