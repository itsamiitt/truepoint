// layout.ts — the shared TruePoint email layout + brand primitives for the transactional auth emails
// (verification code, magic link, password reset). Plain string templates (no React Email dependency):
// email clients need inline styles + table layout and cannot resolve CSS variables, so every brand token is
// a LITERAL hex mirroring packages/ui/src/tokens.css (--tp-ink #111827, --tp-cobalt #2563c9 = fill/logo
// only, primary button = ink). The stacked-chevron mark mirrors apps/auth/src/shared/BrandLockup.tsx.
// Every template renders BOTH an html (primary) and a text (fallback) part.

/** Brand tokens as literal hexes (email can't resolve CSS vars). Mirrors packages/ui/src/tokens.css. */
const INK = "#111827";
const INK_2 = "#374151";
const MUTED = "#6b7280";
const SURFACE = "#ffffff";
const SURFACE_2 = "#f9fafb";
const HAIRLINE = "#f0f0f0";
const BORDER = "#e5e7eb";
const COBALT = "#2563c9"; // fill / logo only — never text (brand rule, tokens.css §brand accent)
const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

/** A ready-to-send email: the subject plus both the branded html part and its plaintext fallback. */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export const BRAND = {
  name: "TruePoint",
  // Footer (brand-identity §10, 08 §6). These are TRANSACTIONAL account-security emails (verification /
  // magic-link / password-reset) — exempt from the CAN-SPAM marketing-unsubscribe rule — so the footer
  // carries the wordmark + postal address + a transactional notice, and DELIBERATELY no unsubscribe link
  // (you cannot opt out of security mail). Flagged for reviewer-qs.
  // TODO(worker-A, 2026-06-16): replace with TruePoint's real registered postal address before prod sends.
  postalAddress: "TruePoint, Inc. · 2261 Market St #4242 · San Francisco, CA 94114",
} as const;

/** Escape the characters that matter when interpolating a value into HTML text or an attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The TruePoint lockup: the stacked-chevron mark (top stroke cobalt) beside the True/Point wordmark. */
function lockup(): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle;padding-right:9px;line-height:0;"><svg width="26" height="26" viewBox="0 0 100 100" fill="none" stroke-width="8.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 43 L50 28 L78 43" stroke="${COBALT}"/><path d="M22 60 L50 45 L78 60" stroke="${INK}"/><path d="M22 77 L50 62 L78 77" stroke="${INK}"/></svg></td>
<td style="vertical-align:middle;font-family:${FONT};font-size:19px;color:${INK};letter-spacing:-0.02em;"><span style="font-weight:400;">True</span><span style="font-weight:800;">Point</span></td>
</tr></table>`;
}

/** A bulletproof, ink-filled primary action button (white text) — the product's "button = Ink" rule. */
export function emailButton(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td bgcolor="${INK}" style="border-radius:8px;"><a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:15px;font-weight:600;color:${SURFACE};text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a></td>
</tr></table>`;
}

/** A large, monospaced, letter-spaced verification-code display block. */
export function codeBlock(code: string): string {
  return `<div style="font-family:${MONO};font-size:30px;font-weight:700;letter-spacing:7px;color:${INK};background:${SURFACE_2};border:1px solid ${BORDER};border-radius:8px;padding:16px 12px;text-align:center;">${escapeHtml(code)}</div>`;
}

/** The copy-paste fallback under a CTA button ("If the button doesn't work, paste this link"). */
export function rawLink(url: string): string {
  return `<p style="margin:16px 0 0;font-family:${FONT};font-size:13px;line-height:1.5;color:${MUTED};">If the button doesn't work, copy and paste this link into your browser:<br><span style="color:${INK_2};word-break:break-all;">${escapeHtml(url)}</span></p>`;
}

/** Wrap an email's body HTML in the full branded document (header lockup + body + compliance footer). */
export function renderHtml(args: {
  previewText: string;
  heading: string;
  bodyHtml: string;
}): string {
  const { previewText, heading, bodyHtml } = args;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background:${SURFACE_2};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${SURFACE_2};">${escapeHtml(previewText)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${SURFACE_2};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:${SURFACE};border:1px solid ${BORDER};border-radius:12px;">
<tr><td style="padding:30px 34px 0;">${lockup()}</td></tr>
<tr><td style="padding:22px 34px 6px;font-family:${FONT};color:${INK};">
<h1 style="margin:0 0 14px;font-size:19px;font-weight:600;line-height:1.35;color:${INK};">${escapeHtml(heading)}</h1>
<div style="font-size:15px;line-height:1.6;color:${INK_2};">${bodyHtml}</div>
</td></tr>
<tr><td style="padding:26px 34px 30px;">
<div style="border-top:1px solid ${HAIRLINE};padding-top:18px;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTED};">
<div style="color:${INK_2};font-size:13px;letter-spacing:-0.01em;"><span style="font-weight:400;">True</span><span style="font-weight:800;">Point</span></div>
<div style="margin-top:6px;">${escapeHtml(BRAND.postalAddress)}</div>
<div style="margin-top:8px;">You're receiving this because someone used this email to sign in to or manage a ${BRAND.name} account. This is an automated account-security message — it can't be unsubscribed from. If it wasn't you, you can safely ignore it.</div>
</div>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

/** The plaintext fallback: the body text followed by the same brand + postal footer. */
export function renderText(bodyText: string): string {
  return `${bodyText}\n\n— ${BRAND.name}\n${BRAND.postalAddress}\nYou're receiving this because someone used this email to sign in to or manage a ${BRAND.name} account. This is an automated account-security message; it can't be unsubscribed from. If it wasn't you, you can safely ignore it.`;
}
