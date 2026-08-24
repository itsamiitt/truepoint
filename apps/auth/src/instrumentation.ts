// instrumentation.ts — Next.js boot hook (Next 15: stable, no experimental flag). The JWT signing self-test
// lives in a SEPARATE node-only module imported ONLY under the Node.js runtime: this app's middleware forces
// an Edge compilation too, and the self-test transitively pulls ioredis (Node built-ins like net/dns/stream)
// which the Edge runtime can't bundle. Gating the dynamic import on NEXT_RUNTIME === "nodejs" keeps it (and
// ioredis) out of the Edge bundle — the documented Next.js pattern for runtime-specific instrumentation.
//
// Sentry is initialised FIRST in each branch, so a failure inside the signing self-test is itself reported
// rather than lost — that self-test is precisely the thing whose failure takes sign-in down (a mangled PEM
// once produced token_mint_failed 503s), so it is the last code that should run uninstrumented.
import * as Sentry from "@sentry/nextjs";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config.ts");
    const { runSigningKeySelfTest } = await import("./bootSelfTest.ts");
    await runSigningKeySelfTest();
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config.ts");
  }
}

// Captures unhandled server-side request errors (nested React Server Components included), which the
// error boundary never sees.
export const onRequestError = Sentry.captureRequestError;
