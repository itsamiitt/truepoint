// page.tsx — app.truepoint.in/auth/callback: receives the single-use code from the auth origin, validates
// the round-tripped state, exchanges the code for an in-memory access token (ADR-0016), then returns home.
"use client";

import { useEffect, useState } from "react";
import { completeLogin } from "@/lib/authClient";

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
      .catch(() => setError("Sign-in could not be completed. Please try again."));
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
