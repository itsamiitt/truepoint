// mfaChanged.ts — a SECURITY-NOTIFICATION email (AUTH-067, 0.5c): sent to the account email when a two-factor
// method is ENROLLED, REMOVED, or the recovery codes are REGENERATED in /account/security — so an attacker who
// has the password (and passed step-up) cannot silently reshape the account's second factor without the real
// owner noticing. Carries no secret; a single "if this wasn't you → secure your account" CTA into the
// forgot-password flow. Branded HTML + plaintext fallback, same shape as passwordChanged.ts.
import { type RenderedEmail, emailButton, rawLink, renderHtml, renderText } from "./layout.ts";

export type MfaChangeKind = "enrolled" | "disabled" | "recovery_regenerated";

export interface MfaChangedInput {
  change: MfaChangeKind;
  /** Link into the re-secure (forgot-password) flow, shown under "If this wasn't you". Omitted → no CTA button. */
  secureUrl?: string;
}

interface Copy {
  subject: string;
  heading: string;
  previewText: string;
  lead: string;
}

const COPY: Record<MfaChangeKind, Copy> = {
  enrolled: {
    subject: "Two-factor authentication was enabled on your TruePoint account",
    heading: "Two-factor authentication enabled",
    previewText: "A new two-factor method was added to your TruePoint account",
    lead: "A new two-factor authentication method was just added to your TruePoint account.",
  },
  disabled: {
    subject: "A two-factor method was removed from your TruePoint account",
    heading: "Two-factor method removed",
    previewText: "A two-factor method was removed from your TruePoint account",
    lead: "A two-factor authentication method was just removed from your TruePoint account.",
  },
  recovery_regenerated: {
    subject: "Your TruePoint recovery codes were regenerated",
    heading: "Recovery codes regenerated",
    previewText: "Your TruePoint recovery codes were regenerated",
    lead: "Your TruePoint recovery codes were just regenerated. Your previous recovery codes no longer work.",
  },
};

export function mfaChangedEmail({ change, secureUrl }: MfaChangedInput): RenderedEmail {
  const c = COPY[change];
  const cta = secureUrl
    ? `${emailButton(secureUrl, "Secure your account")}${rawLink(secureUrl)}`
    : "";
  const bodyHtml = `<p style="margin:0 0 16px;">${c.lead} If you made this change, no action is needed.</p><p style="margin:0 0 18px;">If you didn't, your account may be at risk — reset your password now and review your two-factor settings.</p>${cta}`;
  const secureText = secureUrl ? `\n\nReset your password now: ${secureUrl}` : "";
  const text = `${c.lead}\n\nIf you made this change, no action is needed. If you didn't, your account may be at risk — reset your password now and review your two-factor settings.${secureText}`;
  return {
    subject: c.subject,
    html: renderHtml({ previewText: c.previewText, heading: c.heading, bodyHtml }),
    text: renderText(text),
  };
}
