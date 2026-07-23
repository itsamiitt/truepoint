// PasskeySignIn.tsx — the "Use a passkey" option on the MFA step (AUTH-024). Fetches an authentication challenge
// for the pending login's user, runs navigator.credentials.get via @simplewebauthn/browser (startAuthentication
// handles the base64url encoding), and submits the assertion to the submitMfaPasskey server action, which
// verifies it and advances the login exactly like a TOTP code. Rendered only when WEBAUTHN_ENABLED. A cancelled
// prompt / options failure just resets the button (the action itself redirects on success or failure).
"use client";

import { AUTH_BASE_PATH } from "@/lib/authUrl";
import { Button } from "@leadwolf/ui";
import {
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
} from "@simplewebauthn/browser";
import { useState } from "react";
import { submitMfaPasskey } from "./actions";

const OPTIONS_URL = `${AUTH_BASE_PATH}/mfa/passkey/options`;

export function PasskeySignIn(): React.JSX.Element {
  const [busy, setBusy] = useState(false);

  async function signIn(): Promise<void> {
    setBusy(true);
    try {
      const res = await fetch(OPTIONS_URL, { method: "POST" });
      if (!res.ok) throw new Error("options");
      const optionsJSON = (await res.json()) as PublicKeyCredentialRequestOptionsJSON;
      const assertion = await startAuthentication({ optionsJSON });
      await submitMfaPasskey(assertion); // server action verifies + redirects (success → app; failure → /mfa)
    } catch {
      setBusy(false); // cancelled prompt / options failure → reset the button and let the user retry or use TOTP
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="full"
      onClick={() => void signIn()}
      disabled={busy}
    >
      {busy ? "Follow your browser…" : "Use a passkey"}
    </Button>
  );
}
