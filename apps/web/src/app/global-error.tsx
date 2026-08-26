"use client";

// global-error.tsx — the last-resort App Router boundary: root-layout failures and render errors that no
// nested error.tsx caught. Next replaces the whole document here, so this file owns <html>/<body>.
//
// It used to render `<NextError statusCode={0} />`: the unbranded Next.js default. That is the ONE screen a
// user sees when everything else has failed, and it looked like a framework error page rather than ours.
//
// Everything below is inline and literal ON PURPOSE. global-error.tsx renders OUTSIDE the root layout, so
// the layout's `globals.css` import — and with it tokens.css — never loads: a `var(--tp-*)` here resolves to
// nothing and the page would render unstyled, which is the failure mode this file exists to avoid. The
// values are copied from tokens.css and are the only place in the app allowed to do that.
// design-tokens-ok: renders outside the root layout, so no stylesheet (and therefore no token) is loaded
// raw-px-ok: same reason — var(--tp-*) resolves to nothing here, so the literal px values below must stay
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#f9fafb" }}>
        <main
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
            color: "#111827",
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 420,
              background: "#ffffff",
              border: "1px solid #e5e7eb",
              borderRadius: 14,
              boxShadow: "0 1px 2px rgba(17, 24, 39, 0.04)",
              padding: 24,
            }}
          >
            <p style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>TruePoint</p>
            <h1
              style={{
                margin: "12px 0 0",
                fontSize: 22,
                fontWeight: 600,
                letterSpacing: "-0.01em",
              }}
            >
              Something went wrong
            </h1>
            <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.5, color: "#6b7280" }}>
              TruePoint hit an unexpected error and could not finish loading. The failure has been
              reported automatically. Reloading usually clears it.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                marginTop: 20,
                height: 36,
                padding: "0 14px",
                border: "1px solid transparent",
                borderRadius: 8,
                background: "#111827",
                color: "#ffffff",
                fontSize: 14,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Reload
            </button>
            {/* The digest is what support needs to find this exact crash in Sentry — showing it saves a
                round trip, and it identifies an event, not a person. */}
            {error.digest ? (
              <p style={{ margin: "16px 0 0", fontSize: 12, color: "#6b7280" }}>
                Reference: <code>{error.digest}</code>
              </p>
            ) : null}
          </div>
        </main>
      </body>
    </html>
  );
}
