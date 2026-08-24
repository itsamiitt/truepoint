"use client";

// The client half of the temporary Sentry check: a real uncaught error from a browser event handler.
export function SentryCheckButton() {
  return (
    <button
      type="button"
      onClick={() => {
        throw new Error(
          "TruePoint Sentry verification — client-side error from apps/web browser runtime",
        );
      }}
      style={{ padding: "8px 14px", fontSize: 14, cursor: "pointer" }}
    >
      Throw a client error
    </button>
  );
}
