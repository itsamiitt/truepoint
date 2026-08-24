// instrumentation-client.ts — the BROWSER runtime for apps/admin.
// Next 15 loads this file directly for the client bundle (the older name was sentry.client.config.ts).
import * as Sentry from "@sentry/nextjs";
import { sharedOptions } from "./sentry.shared.ts";

Sentry.init({
  ...sharedOptions,
  // Which of the four apps an event came from. One Sentry project serves all of them, so without this tag
  // a "TypeError in DataTable" is unattributable — the shared @leadwolf/ui renders in every one.
  initialScope: { tags: { app: "admin" } },
});

// App Router navigation spans. Without it a client-side route change is invisible to tracing.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
