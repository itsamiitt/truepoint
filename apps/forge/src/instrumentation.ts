// instrumentation.ts — Next.js boot hook for apps/forge (Next 15: stable, no experimental flag).
// Dispatches the Sentry init that matches the runtime being compiled.
import * as Sentry from "@sentry/nextjs";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config.ts");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config.ts");
  }
}

// Captures unhandled server-side request errors (nested React Server Components included), which the
// error boundary below never sees.
export const onRequestError = Sentry.captureRequestError;
