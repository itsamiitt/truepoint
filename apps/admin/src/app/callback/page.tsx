// callback/page.tsx — admin.truepoint.internal/callback: receives the single-use code from the auth origin,
// validates the round-tripped state, exchanges the code for an in-memory access token (ADR-0016), then returns
// to the console root (which redirects to /tenants, where the staff gate runs). A `ran` ref guards against
// React StrictMode's double-invoke; on a recoverable failure we auto-restart login exactly once. Mirrors the
// apps/web callback. This route sits OUTSIDE the (shell) group so the gate doesn't run mid-exchange.
"use client";

import { RECOVERY_KEY, completeLogin, recoveryActionFor, startLogin } from "@/lib/authClient";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

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
  const ran = useRef(false);
  const router = useRouter();

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      sessionStorage.removeItem(RECOVERY_KEY);
      setError("Missing authorization code.");
      return;
    }
    completeLogin(code, state)
      .then(() => {
        sessionStorage.removeItem(RECOVERY_KEY);
        // Client-side nav (NOT window.location): keeps the just-minted in-memory access token alive across the
        // hop to the console, so the staff gate passes immediately instead of forcing a fresh silent refresh
        // (AUTH-078, mirrors apps/web). "/" redirects to /tenants where the gate runs.
        router.replace("/");
      })
      .catch(async (err: unknown) => {
        const reason = err instanceof Error ? err.message : "unknown";
        if (
          recoveryActionFor(reason) === "restart" &&
          sessionStorage.getItem(RECOVERY_KEY) !== "1"
        ) {
          sessionStorage.setItem(RECOVERY_KEY, "1");
          try {
            await startLogin();
            return;
          } catch {
            sessionStorage.removeItem(RECOVERY_KEY);
          }
        } else {
          sessionStorage.removeItem(RECOVERY_KEY);
        }
        console.warn(`[admin] sign-in could not complete: ${reason}`);
        setError(messageFor(reason));
      });
  }, [router]);

  return (
    <div className="tp-center-screen">
      {error ? (
        <p className="app-muted">
          {error} <a href="/">Back to sign in</a>
        </p>
      ) : (
        <p className="app-muted">Signing you in…</p>
      )}
    </div>
  );
}
