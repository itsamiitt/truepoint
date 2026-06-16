// magicLink.ts — the passwordless sign-in ("magic link") email (17 §2/§9). A single ink CTA to the one-click
// /magic/confirm link plus a copy-paste fallback. Branded HTML + plaintext fallback. Single-use, time-boxed.
import { type RenderedEmail, emailButton, rawLink, renderHtml, renderText } from "./layout.ts";

export interface MagicLinkInput {
  link: string;
  expiresMinutes?: number;
}

export function magicLinkEmail({ link, expiresMinutes = 15 }: MagicLinkInput): RenderedEmail {
  const bodyHtml = `<p style="margin:0 0 18px;">Click the button below to sign in. This link expires in ${expiresMinutes} minutes and can be used once.</p>${emailButton(link, "Sign in to TruePoint")}${rawLink(link)}<p style="margin:16px 0 0;color:#6b7280;font-size:13px;">If you didn't request this, you can safely ignore this email.</p>`;
  const text = `Sign in to TruePoint using this link (expires in ${expiresMinutes} minutes, single use):\n\n${link}\n\nIf you didn't request this, you can safely ignore this email.`;
  return {
    subject: "Your TruePoint sign-in link",
    html: renderHtml({
      previewText: `Your single-use sign-in link (expires in ${expiresMinutes} minutes)`,
      heading: "Sign in to TruePoint",
      bodyHtml,
    }),
    text: renderText(text),
  };
}
