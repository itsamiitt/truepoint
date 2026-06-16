// page.tsx — app.truepoint.in/auth/callback: receives the single-use code from the auth origin, validates
// the round-tripped state, exchanges the code for an in-memory access token (ADR-0016), then returns home.
// On failure we log the real reason to the console (DevTools) and map it to a user-facing message — a
// transient session/PKCE problem invites another attempt; a server fault asks the user to wait.
"use client";

import { completeLogin } from "@/lib/authClient";
import { useEffect, useState } from "react";

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

  useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      setError("Missing authorization code.");
      return;
    }
    completeLogin(code, state)
      .then(() => window.location.replace("/"))
      .catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : "unknown";
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
