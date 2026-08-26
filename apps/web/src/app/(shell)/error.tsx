// (shell)/error.tsx — the route-level error boundary for every signed-in destination.
//
// Without this, an unhandled render error anywhere under (shell) fell through to Next's default error page,
// which discards the entire AppShell chrome: the user lost the rail, the top bar, and any way back other than
// the browser button. A route-group boundary keeps the shell intact and turns the failure into a recoverable
// state — `reset()` re-renders the segment, which is usually enough for a transient data error.
//
// Note the four-states discipline this completes: individual surfaces already handle loading / empty / error at
// the FETCH level via StateSwitch, but a boundary is what catches the errors a fetch state cannot — a genuine
// render throw. Both are needed.
//
// This must be a client component: Next passes it an `error` object and a `reset` callback.
"use client";

import { EmptyState, TpButton } from "@leadwolf/ui";
import { useEffect } from "react";

export default function ShellError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface it for diagnosis. `digest` is the server-side identifier Next assigns so a production error can be
    // correlated with the server log; the message itself is deliberately NOT rendered to the user, since a raw
    // error string can carry internals.
    console.error("[shell] route error", { digest: error.digest, message: error.message });
  }, [error]);

  return (
    <div
      style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "60vh" }}
    >
      <EmptyState
        title="Something went wrong on this page"
        description="The page failed to load. Trying again usually resolves it — if it keeps happening, the reference below helps support trace it."
        action={
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "var(--tp-space-2)",
            }}
          >
            <TpButton onClick={reset}>Try again</TpButton>
            {error.digest ? (
              <span style={{ color: "var(--tp-ink-3)", fontSize: "var(--tp-text-caption)" }}>
                Reference: {error.digest}
              </span>
            ) : null}
          </div>
        }
      />
    </div>
  );
}
