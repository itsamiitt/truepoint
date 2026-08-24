// sentry.server.config.ts — the NODE.JS runtime for apps/web.
// Loaded by instrumentation.ts when NEXT_RUNTIME === "nodejs".
//
// `includeLocalVariables` is deliberately NOT set — see sentry.shared.ts.
import * as Sentry from "@sentry/nextjs";
import { sharedOptions } from "./sentry.shared.ts";

Sentry.init({
  ...sharedOptions,
  initialScope: { tags: { app: "web", runtime: "nodejs" } },
});
