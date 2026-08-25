// sentry-check/page.tsx — TEMPORARY verification surface. Delete once Sentry is confirmed.
//
// Exists to prove the DEPLOYED app reports through its own init path — the thing a curl to the ingest
// endpoint cannot show. Both halves throw REAL errors from real code: the server half from a Server
// Component render (caught by `onRequestError` in instrumentation.ts), the client half from a browser
// event handler (caught by instrumentation-client.ts).
//
// Gated on an exact query token so a crawler, an uptime probe, or a stray link can never trip a 500 —
// without the token this renders as an inert page.
import { SentryCheckButton } from "./SentryCheckButton";

const TOKEN = "tp-verify-2026";

export default async function SentryCheckPage({
  searchParams,
}: {
  searchParams: Promise<{ throw?: string; token?: string }>;
}) {
  const { throw: which, token } = await searchParams;

  if (which === "server" && token === TOKEN) {
    // A genuine unhandled render error, thrown from the Node.js runtime this page renders in.
    throw new Error(
      "TruePoint Sentry verification — server-side error from apps/web Server Component",
    );
  }

  return (
    <main
      style={{
        padding: "var(--tp-space-8)",
        fontFamily: "system-ui, sans-serif",
        maxWidth: 640,
      }}
    >
      <h1 style={{ fontSize: "var(--tp-text-heading)", fontWeight: 600 }}>Sentry verification</h1>
      <p style={{ fontSize: "var(--tp-text-label)", lineHeight: 1.6 }}>
        Temporary page. Each control raises a real error so it travels the same path a production
        fault would. Nothing here reports contact data — PII is off in the SDK config.
      </p>
      <ul style={{ fontSize: "var(--tp-text-label)", lineHeight: 1.8 }}>
        <li>
          <a href={`/sentry-check?throw=server&token=${TOKEN}`}>Throw a server error</a> — Server
          Component render, captured by <code>onRequestError</code>.
        </li>
        <li>Client error — the button below throws in the browser.</li>
      </ul>
      <SentryCheckButton />
    </main>
  );
}
