// Shared Sentry options for every runtime of this app.
//
// PII IS OFF, deliberately and by decision (CLAUDE.md rule 3). These surfaces render revealed contact data
// — names, work emails, direct dials — and the request bodies carry contact records and reveal payloads.
// Sentry's own recommended Next.js config would ship all of that to a US-hosted processor, so three of its
// defaults are turned OFF here rather than inherited:
//   - dataCollection.userInfo / httpBodies : no user identity, no request or response bodies
//   - sendDefaultPii                       : no IP addresses, no cookies, no headers that carry them
//   - includeLocalVariables (server)       : NOT set — locals in this codebase hold decrypted contact
//                                            fields and blind-index inputs, which is exactly what a
//                                            stack-frame snapshot would capture
// Session Replay is likewise not installed: it records the DOM, and on these screens the DOM IS the PII.
//
// Turning any of them on is a compliance decision (09-compliance.md) plus a sub-processor entry, not a
// config tweak. Each is a one-line change here when that decision is taken.
const DEV = process.env.NODE_ENV === "development";

export const sharedOptions = {
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // `environment` and `release` are what make every release feature work; without them events land tagged
  // "unknown release" and regressions can't be attributed to a deploy. Both ride NEXT_PUBLIC_* because
  // turbo.json's build task only forwards that prefix — an undeclared var is stripped at build time.
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
  release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,

  // Full sampling while developing; 10% in production, the SDK's recommended default.
  tracesSampleRate: DEV ? 1.0 : 0.1,

  sendDefaultPii: false,
  // NOT `as const` on this object: the SDK types httpBodies as a MUTABLE array, so a readonly [] from a
  // const assertion fails to assign in all three runtimes.
  dataCollection: { userInfo: false, httpBodies: [] as [] },

  // No DSN configured (local dev, CI) => the SDK is inert rather than throwing or buffering.
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
};
