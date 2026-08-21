// sentry.edge.config.ts — the EDGE runtime for apps/web.
// Loaded by instrumentation.ts when NEXT_RUNTIME === "edge". Middleware compiles to this runtime, so it is
// a separate init even where the app has no explicit edge routes.
import * as Sentry from "@sentry/nextjs";
import { sharedOptions } from "./sentry.shared.ts";

Sentry.init({
  ...sharedOptions,
  initialScope: { tags: { app: "web", runtime: "edge" } },
});
