// mailTransport.ts — classify an SMTP transport URL. AUTH-061: the production deploy shipped
// `SMTP_URL=smtp://mailhog:1025` — a dev mail-CAPTURE tool, not a delivering relay — so every reset /
// verification / magic email was captured on-box and never reached the recipient (the real reason
// "forgot password is broken"). The mailer uses this to flag a dev-capture transport LOUDLY at send time in
// production instead of pretending it delivered. Pure + dependency-free so it is unit-testable without
// loading env or nodemailer.

// Hosts that capture-but-do-not-deliver mail (dev/preview tooling) or are unroutable loopbacks. A production
// transport pointed at any of these does not deliver to real inboxes.
const DEV_CAPTURE_HOSTS = new Set([
  "mailhog",
  "mailpit",
  "maildev",
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
]);

/** The hostname of `smtpUrl` when it is a known dev mail-capture / loopback host, else null. Never throws. */
export function devCaptureHost(smtpUrl: string): string | null {
  let host: string;
  try {
    host = new URL(smtpUrl).hostname.toLowerCase();
  } catch {
    return null; // unparseable — let nodemailer surface its own error rather than mislabel it here
  }
  // URL() wraps IPv6 hosts in brackets; strip them so "[::1]" matches "::1".
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return DEV_CAPTURE_HOSTS.has(bare) ? bare : null;
}

/** True when `smtpUrl` points at a dev mail-capture / loopback host (i.e. will not deliver to real inboxes). */
export function isDevCaptureTransport(smtpUrl: string): boolean {
  return devCaptureHost(smtpUrl) !== null;
}
