// page.tsx — the app home. On load it tries a silent refresh (using the auth-origin refresh cookie); if a
// token results, it calls the API (which validates the JWT via JWKS) and shows the session. Otherwise it
// offers "Sign in", which starts the PKCE redirect to the auth origin.
"use client";

import { useEffect, useState } from "react";
import { fetchWithAuth, getAccessToken, silentRefresh, startLogin } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";

interface Session {
  userId: string;
  tenantId: string;
  workspaceId: string | null;
  scope: string[];
}

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void (async () => {
      if (!getAccessToken()) await silentRefresh();
      if (getAccessToken()) {
        const res = await fetchWithAuth(`${API_BASE}/api/v1/auth/session`);
        if (res.ok) setSession((await res.json()) as Session);
      }
      setReady(true);
    })();
  }, []);

  if (!ready) {
    return (
      <main className="app-main">
        <p className="app-muted">Loading…</p>
      </main>
    );
  }

  return (
    <main className="app-main">
      <h1>TruePoint</h1>
      {session ? (
        <>
          <p className="app-muted">Signed in. Session resolved from a JWT the API validated via JWKS:</p>
          <pre className="app-pre">{JSON.stringify(session, null, 2)}</pre>
        </>
      ) : (
        <>
          <p className="app-muted">You&apos;re signed out.</p>
          <button className="app-button" type="button" onClick={() => void startLogin()}>
            Sign in
          </button>
        </>
      )}
    </main>
  );
}
