// bootSelfTest.ts — node-only boot self-test. Imported by instrumentation.ts ONLY under the Node.js runtime
// (see the NEXT_RUNTIME guard there), so its ioredis-pulling transitive deps never reach the Edge bundle.
// Proves the JWT signing key can mint at startup and logs a FATAL line if it can't — deliberately NO
// process.exit (crash-looping auth would keep it unhealthy and block Caddy; deploy.sh's post-deploy smoke
// test is the hard gate). Never logs the PEM/token — only the error name/message.
import { assertSigningKey, log } from "@leadwolf/auth";
import { env } from "@leadwolf/config";
import { devCaptureHost, transportHost } from "./lib/mailTransport.ts";

export async function runSigningKeySelfTest(): Promise<void> {
  try {
    await assertSigningKey();
    log.info("auth.boot.signing_key_ok");
  } catch (err) {
    log.error("auth.boot.FATAL.signing_key_unavailable", {
      err: err instanceof Error ? err.name : "unknown",
      message: err instanceof Error ? err.message : "unknown",
    });
  }
}

/**
 * Report at BOOT whether this process can actually deliver mail.
 *
 * mailer.ts already flags an unset or dev-capture transport, but only at SEND time — so the signal existed
 * exclusively in the moment a real user tried to reset their password, buried in request logs, on a path whose
 * user-facing response is deliberately identical either way (the confirmation is enumeration-safe, so a
 * non-delivering relay looks exactly like a delivering one from the outside). That is how
 * `deploy/env.production.template` came to ship `SMTP_URL=` empty with nobody noticing that password reset,
 * email verification and magic links were all silently dead. AUTH-061 was the same failure with a MailHog URL
 * instead of an empty one.
 *
 * Hoisting the check to startup makes it a property of the deployment rather than of someone's bad afternoon:
 * one greppable line per process start, before any user is affected.
 *
 * NO process.exit and no throw, matching the signing-key test above. Email is not on the critical path for a
 * password or SSO sign-in, so refusing to boot over it would convert a degraded feature into an auth outage —
 * strictly worse than the problem. Never logs SMTP_URL or an error derived from it: the password component is
 * the provider API key, so only the hostname is ever emitted.
 */
export function runMailTransportSelfTest(): void {
  if (env.NODE_ENV !== "production") {
    // By design outside production: mailer.ts prints the message (code included) to the console so the whole
    // SSR flow is exercisable with no relay configured. Nothing to assert.
    log.info("auth.boot.mail_transport_console", { mode: env.NODE_ENV });
    return;
  }
  if (!env.SMTP_URL) {
    log.error("auth.boot.FATAL.mail_transport_unset", {
      impact: "password reset, email verification and magic links do not deliver",
    });
    return;
  }
  const capture = devCaptureHost(env.SMTP_URL);
  if (capture) {
    log.error("auth.boot.FATAL.mail_transport_is_dev_capture", {
      host: capture,
      impact: "mail is captured on-box and never reaches the recipient",
    });
    return;
  }
  log.info("auth.boot.mail_transport_ok", { host: transportHost(env.SMTP_URL) ?? "unparseable" });
}
