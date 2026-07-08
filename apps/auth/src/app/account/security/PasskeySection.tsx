// PasskeySection.tsx — account-security UI to enroll a passkey (AUTH-024). Runs the WebAuthn registration
// ceremony from the browser via @simplewebauthn/browser (startRegistration handles the ArrayBuffer↔base64url
// encoding): fetch the server options → prompt the authenticator → POST the attestation back to verify. Rendered
// only when WEBAUTHN_ENABLED (the page gates it), and the routes it calls 404 when off, so this is fully inert
// until passkeys are turned on. A cancelled browser prompt is a soft notice, not an error.
"use client";

import { AUTH_BASE_PATH } from "@/lib/authUrl";
import { AccountSectionCard } from "@/shared/AccountShell";
import { Alert, Button } from "@leadwolf/ui";
import {
  type PublicKeyCredentialCreationOptionsJSON,
  startRegistration,
} from "@simplewebauthn/browser";
import { useState } from "react";

const OPTIONS_URL = `${AUTH_BASE_PATH}/account/security/passkeys/register/options`;
const VERIFY_URL = `${AUTH_BASE_PATH}/account/security/passkeys/register/verify`;

export function PasskeySection(): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function addPasskey(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      const optRes = await fetch(OPTIONS_URL, { method: "POST" });
      if (!optRes.ok) throw new Error("options");
      const optionsJSON = (await optRes.json()) as PublicKeyCredentialCreationOptionsJSON;
      const attResp = await startRegistration({ optionsJSON });
      const vRes = await fetch(VERIFY_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response: attResp, label: navigator.platform || "Passkey" }),
      });
      const { verified } = (await vRes.json()) as { verified?: boolean };
      if (!verified) throw new Error("verify");
      setMsg({ ok: true, text: "Passkey added — you can use it to sign in." });
    } catch (e) {
      const cancelled =
        e instanceof Error && (e.name === "NotAllowedError" || e.name === "AbortError");
      setMsg({
        ok: false,
        text: cancelled
          ? "Passkey setup was cancelled."
          : "Could not add a passkey. Please try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <AccountSectionCard
      id="passkeys"
      title="Passkeys"
      description="Sign in with your device's fingerprint, face, or PIN instead of a password or code — phishing-resistant."
    >
      {msg ? (
        <Alert variant={msg.ok ? "default" : "destructive"} role="status" className="mb-4">
          {msg.text}
        </Alert>
      ) : null}
      <Button onClick={() => void addPasskey()} disabled={busy}>
        {busy ? "Follow your browser…" : "Add a passkey"}
      </Button>
    </AccountSectionCard>
  );
}
