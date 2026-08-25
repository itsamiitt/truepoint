"use client";

import { TpButton } from "@leadwolf/ui";

// The client half of the temporary Sentry check: a real uncaught error from a browser event handler.
// The inline padding/font-size/cursor it used to carry are exactly TpButton's own base, so they are gone.
export function SentryCheckButton() {
  return (
    <TpButton
      variant="secondary"
      onClick={() => {
        throw new Error(
          "TruePoint Sentry verification — client-side error from apps/web browser runtime",
        );
      }}
    >
      Throw a client error
    </TpButton>
  );
}
