// newSignIn.ts — a SECURITY-NOTIFICATION email (AUTH-067, 0.5b): sent when a NEW sign-in to the account is
// detected, so the owner can catch an unauthorized login. This template is PRESENTATIONAL only — the caller
// decides WHEN to send (it should be new-device / new-location, NOT every login, or it becomes alert-fatigue
// noise) and formats the device string; the template renders whatever context it is given and degrades
// gracefully when a field is absent. No secret; a single "if this wasn't you → secure your account" CTA.
// Device/IP are interpolated into HTML, so both are escapeHtml'd (a user-agent-derived device string is
// attacker-influenced). Branded HTML + plaintext fallback, same shape as passwordChanged.ts / mfaChanged.ts.
import {
  type RenderedEmail,
  emailButton,
  escapeHtml,
  rawLink,
  renderHtml,
  renderText,
} from "./layout.ts";

export interface NewSignInInput {
  /** Human-formatted device/browser, e.g. "Chrome on macOS" (caller derives it from the user-agent). Optional. */
  device?: string;
  /** The sign-in IP, shown so the owner can recognize or deny it. Optional (omitted → not shown). */
  ipAddress?: string;
  /** Link into the re-secure (forgot-password) flow, shown under "If this wasn't you". Omitted → no CTA button. */
  secureUrl?: string;
}

export function newSignInEmail({
  device,
  ipAddress,
  secureUrl,
}: NewSignInInput = {}): RenderedEmail {
  // A muted "— <device> · IP <ip>" context suffix built from ONLY the fields we actually have (no "undefined").
  const bits = [device, ipAddress ? `IP ${ipAddress}` : undefined].filter(Boolean) as string[];
  const joined = bits.join(" · ");
  const contextText = joined ? ` — ${joined}` : "";
  const contextHtml = joined ? ` — ${escapeHtml(joined)}` : "";
  const cta = secureUrl
    ? `${emailButton(secureUrl, "Secure your account")}${rawLink(secureUrl)}`
    : "";
  const bodyHtml = `<p style="margin:0 0 16px;">We noticed a new sign-in to your TruePoint account${contextHtml}. If this was you, no action is needed.</p><p style="margin:0 0 18px;">If you don't recognize it, your account may be at risk — reset your password now and review your active sessions.</p>${cta}`;
  const secureText = secureUrl ? `\n\nReset your password now: ${secureUrl}` : "";
  const text = `We noticed a new sign-in to your TruePoint account${contextText}.\n\nIf this was you, no action is needed. If you don't recognize it, your account may be at risk — reset your password now and review your active sessions.${secureText}`;
  return {
    subject: "New sign-in to your TruePoint account",
    html: renderHtml({
      previewText: "We noticed a new sign-in to your TruePoint account",
      heading: "New sign-in detected",
      bodyHtml,
    }),
    text: renderText(text),
  };
}
