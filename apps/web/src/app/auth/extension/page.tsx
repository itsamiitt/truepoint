// page.tsx — app.truepoint.in/auth/extension: the COMPANION-WINDOW handoff (ADR-0045, chrome-extension
// doc 12). The extension opens this in a popup window with ?state=<nonce>&ext_id=<id>. Here we ensure the
// user has a web session (the AppShell silent-refresh/login pattern), mint an EXTENSION-SCOPED token from the
// auth origin, and hand it to the extension via chrome.runtime.sendMessage — which the extension accepts only
// after verifying sender.origin + the state nonce, then closes this window.
//
// Having a concrete /auth/extension route also fixes the 500: without it, next.config's `/auth/:path*` rewrite
// proxied this path to the auth service (which has no such page). A filesystem route wins over that rewrite.
"use client";

import { getAccessToken, silentRefresh, startLogin } from "@/lib/authClient";
import { AUTH_ORIGIN } from "@/lib/publicConfig";
import { useEffect, useRef, useState } from "react";

const EXT_RETURN_KEY = "tp_ext_return";

// Minimal typing for the externally-connectable bridge (apps/web has no @types/chrome).
interface ExtChrome {
  runtime?: {
    sendMessage?: (
      extensionId: string,
      message: unknown,
      callback?: (response?: unknown) => void,
    ) => void;
    lastError?: { message?: string };
  };
}
function extRuntime(): ExtChrome["runtime"] | undefined {
  return (window as unknown as { chrome?: ExtChrome }).chrome?.runtime;
}

interface MintedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export default function ExtensionAuthPage(): React.ReactElement {
  const ran = useRef(false);
  const [message, setMessage] = useState("Signing you in…");

  useEffect(() => {
    if (ran.current) {
      return;
    }
    ran.current = true;
    void run(setMessage);
  }, []);

  return (
    <main className="app-main">
      <p className="app-muted">{message}</p>
    </main>
  );
}

async function run(setMessage: (m: string) => void): Promise<void> {
  const params = new URL(window.location.href).searchParams;
  const state = params.get("state") ?? "";
  const extId = params.get("ext_id") ?? "";
  if (!state || !extId) {
    setMessage("Missing sign-in parameters. Open this from the TruePoint extension.");
    return;
  }

  // Ensure a web session (AppShell gate: mint from the refresh cookie, else start the full login and return here).
  if (!getAccessToken()) {
    await silentRefresh();
  }
  if (!getAccessToken()) {
    try {
      sessionStorage.setItem(EXT_RETURN_KEY, window.location.pathname + window.location.search);
      await startLogin();
      return; // redirecting to the auth origin; the callback returns here after login
    } catch {
      setMessage("Couldn't start sign-in. Please try again.");
      return;
    }
  }

  // Mint an extension-scoped token for the signed-in user.
  let tokens: MintedTokens;
  try {
    const res = await fetch(`${AUTH_ORIGIN}/auth/extension/mint`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ extId }),
    });
    if (!res.ok) {
      setMessage(
        res.status === 403
          ? "This extension isn't registered with TruePoint yet."
          : "Couldn't create an extension session. Please try again.",
      );
      return;
    }
    tokens = (await res.json()) as MintedTokens;
  } catch {
    setMessage("Couldn't reach TruePoint. Please try again.");
    return;
  }

  // Hand off to the extension (it verifies sender.origin + state, then closes this window).
  const runtime = extRuntime();
  if (!runtime?.sendMessage) {
    setMessage("Open this from the TruePoint extension to finish signing in.");
    return;
  }
  runtime.sendMessage(
    extId,
    {
      type: "AUTH_HANDOFF",
      state,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
    },
    () => {
      // The extension closes this window on success; if it didn't (not installed / rejected), show a hint.
      if (runtime.lastError) {
        setMessage(
          "Couldn't reach the extension. Make sure TruePoint is installed, then try again.",
        );
      } else {
        setMessage("You're signed in. You can close this window.");
      }
    },
  );
}
