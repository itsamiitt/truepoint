// sentry.server.config.ts — the NODE.JS runtime for apps/admin.
// Loaded by instrumentation.ts when NEXT_RUNTIME === "nodejs".
//
// `includeLocalVariables` is deliberately NOT set — see sentry.shared.ts.
import * as Sentry from "@sentry/nextjs";
import { sharedOptions } from "./sentry.shared.ts";

Sentry.init({
  ...sharedOptions,
  initialScope: { tags: { app: "admin", runtime: "nodejs" } },
});
