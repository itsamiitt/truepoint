// passkeyChanged.ts — a SECURITY-NOTIFICATION email (AUTH-024): sent to the account email when a passkey is
// ADDED or REMOVED in /account/security — so someone with a live session (even after step-up) cannot silently
// reshape the account's login credentials without the real owner noticing. Carries no secret; a single "if this
// wasn't you → secure your account" CTA into the forgot-password flow. Same shape as mfaChanged.ts.
import { type RenderedEmail, emailButton, rawLink, renderHtml, renderText } from "./layout.ts";

export type PasskeyChangeKind = "added" | "removed";

export interface PasskeyChangedInput {
  change: PasskeyChangeKind;
  /** Link into the re-secure (forgot-password) flow, shown under "If this wasn't you". Omitted → no CTA button. */
  secureUrl?: string;
}

interface Copy {
  subject: string;
  heading: string;
  previewText: string;
  lead: string;
}

const COPY: Record<PasskeyChangeKind, Copy> = {
  added: {
    subject: "A passkey was added to your TruePoint account",
    heading: "Passkey added",
    previewText: "A new passkey was added to your TruePoint account",
    lead: "A new passkey was just added to your TruePoint account.",
  },
  removed: {
    subject: "A passkey was removed from your TruePoint account",
    heading: "Passkey removed",
    previewText: "A passkey was removed from your TruePoint account",
    lead: "A passkey was just removed from your TruePoint account.",
  },
};

export function passkeyChangedEmail({ change, secureUrl }: PasskeyChangedInput): RenderedEmail {
  const c = COPY[change];
  const cta = secureUrl
    ? `${emailButton(secureUrl, "Secure your account")}${rawLink(secureUrl)}`
    : "";
  const bodyHtml = `<p style="margin:0 0 16px;">${c.lead} If you made this change, no action is needed.</p><p style="margin:0 0 18px;">If you didn't, your account may be at risk — reset your password now and review your passkeys.</p>${cta}`;
  const secureText = secureUrl ? `\n\nReset your password now: ${secureUrl}` : "";
  const text = `${c.lead}\n\nIf you made this change, no action is needed. If you didn't, your account may be at risk — reset your password now and review your passkeys.${secureText}`;
  return {
    subject: c.subject,
    html: renderHtml({ previewText: c.previewText, heading: c.heading, bodyHtml }),
    text: renderText(text),
  };
}
