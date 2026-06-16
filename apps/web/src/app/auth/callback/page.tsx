// page.tsx — app.truepoint.in/auth/callback: receives the single-use code from the auth origin, validates
// the round-tripped state, exchanges the code for an in-memory access token (ADR-0016), then returns home.
// A `ran` ref guards the effect against React StrictMode's double-invoke, which would otherwise consume the
// single-use state/code twice and self-inflict `invalid_state`. On a recoverable failure (stale/expired/
// single-use state) we auto-restart a fresh login exactly once — guarded by a sessionStorage flag that
// survives the auth round-trip — so a one-time stale state is no longer a dead end. Otherwise we log the real
// reason to the console (DevTools) and map it to a user-facing message — a server fault asks the user to wait.
"use client";

import { RECOVERY_KEY, completeLogin, recoveryActionFor, startLogin } from "@/lib/authClient";
import { useEffect, useRef, useState } from "react";

/** Map the exchange failure reason to a user-facing message. The raw reason is logged for DevTools. */
function messageFor(reason: string): string {
  if (reason === "invalid_state" || reason === "pkce_mismatch" || reason === "code_not_found") {
    return "Your sign-in session expired or was already used. Please sign in again.";
  }
  if (reason === "auth_unavailable") {
    return "Sign-in is temporarily unavailable. Please try again in a moment.";
  }
  return "Sign-in could not be completed. Please try again.";
}

export default function CallbackPage() {
  const [error, setError] = useState<string | null>(null);
  // One-shot guard: React StrictMode mounts effects twice in dev, and a remount would re-run the body.
  // Running it more than once would consume the single-use state/code twice and self-inflict invalid_state.
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      sessionStorage.removeItem(RECOVERY_KEY); // no recovery was spent landing here — keep the budget intact
      setError("Missing authorization code.");
      return;
    }
    completeLogin(code, state)
      .then(() => {
        sessionStorage.removeItem(RECOVERY_KEY); // clean exit — let a future failure recover once
        window.location.replace("/");
      })
      .catch(async (err: unknown) => {
        const reason = err instanceof Error ? err.message : "unknown";
        // A stale/expired/single-use state can be cleared by a fresh login — auto-restart it, but only once
        // (the flag survives the auth round-trip on this origin) so we never trap the user in a redirect loop.
        if (recoveryActionFor(reason) === "restart" && sessionStorage.getItem(RECOVERY_KEY) !== "1") {
          sessionStorage.setItem(RECOVERY_KEY, "1");
          try {
            await startLogin();
            return; // redirecting to the auth origin; nothing more to render
          } catch {
            // PKCE/sessionStorage can throw in an insecure/private context — fall through to the visible error
            // rather than leaving the page stuck on "Signing you in…" with an unhandled rejection.
            sessionStorage.removeItem(RECOVERY_KEY);
          }
        } else {
          sessionStorage.removeItem(RECOVERY_KEY);
        }
        console.warn(`[auth] sign-in could not complete: ${reason}`);
        setError(messageFor(reason));
      });
  }, []);

  return (
    <main className="app-main">
      {error ? (
        <p className="app-muted">
          {error} <a href="/">Back to sign in</a>
        </p>
      ) : (
        <p className="app-muted">Signing you in…</p>
      )}
    </main>
  );
}
