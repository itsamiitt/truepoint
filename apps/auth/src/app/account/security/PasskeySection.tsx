// PasskeySection.tsx — account-security UI for passkeys (AUTH-024): list the user's registered passkeys, add a
// new one via the WebAuthn registration ceremony (@simplewebauthn/browser handles the ArrayBuffer↔base64url
// encoding + the navigator.credentials.create prompt), and remove one. Rendered only when WEBAUTHN_ENABLED (the
// page gates it), and every route it calls 404s when off, so this is fully inert until passkeys are turned on.
// STEP-UP: add/remove are state-changing credential actions, so the user re-proves their current password or
// authenticator code (sent to the verify/delete routes); a wrong/absent one comes back 403 → "didn't match".
"use client";

import { AUTH_BASE_PATH } from "@/lib/authUrl";
import { AccountSectionCard } from "@/shared/AccountShell";
import { Alert, Button, Input, Label } from "@leadwolf/ui";
import {
  type PublicKeyCredentialCreationOptionsJSON,
  startRegistration,
} from "@simplewebauthn/browser";
import { useCallback, useEffect, useState } from "react";

const BASE = `${AUTH_BASE_PATH}/account/security/passkeys`;
const REAUTH_MSG = "That password or code didn't match. Try again.";

interface PasskeySummary {
  id: string;
  label: string | null;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export function PasskeySection(): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]);
  const [stepUp, setStepUp] = useState("");

  const reload = useCallback(async () => {
    try {
      const res = await fetch(BASE);
      if (res.ok) setPasskeys(((await res.json()) as { passkeys: PasskeySummary[] }).passkeys);
    } catch {
      // best-effort — a failed list load just shows an empty list; the add flow still works.
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function addPasskey(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      const optRes = await fetch(`${BASE}/register/options`, { method: "POST" });
      if (!optRes.ok) throw new Error("options");
      const optionsJSON = (await optRes.json()) as PublicKeyCredentialCreationOptionsJSON;
      const attResp = await startRegistration({ optionsJSON });
      const vRes = await fetch(`${BASE}/register/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response: attResp, label: navigator.platform || "Passkey", stepUp }),
      });
      if (vRes.status === 403) throw new Error("reauth");
      const { verified } = (await vRes.json()) as { verified?: boolean };
      if (!verified) throw new Error("verify");
      setStepUp("");
      setMsg({ ok: true, text: "Passkey added — you can use it to sign in." });
      await reload();
    } catch (e) {
      const reauth = e instanceof Error && e.message === "reauth";
      const cancelled =
        e instanceof Error && (e.name === "NotAllowedError" || e.name === "AbortError");
      setMsg({
        ok: false,
        text: reauth
          ? REAUTH_MSG
          : cancelled
            ? "Passkey setup was cancelled."
            : "Could not add a passkey. Please try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function removePasskey(id: string): Promise<void> {
    setMsg(null);
    const res = await fetch(`${BASE}/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stepUp }),
    });
    if (res.status === 403) {
      setMsg({ ok: false, text: REAUTH_MSG });
      return;
    }
    setStepUp("");
    await reload();
  }

  const canAct = stepUp.length > 0 && !busy;

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

      {passkeys.length > 0 ? (
        <ul className="mb-4 flex flex-col gap-2">
          {passkeys.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 text-sm">
              <span>
                {p.label ?? "Passkey"}
                {p.backedUp ? " · synced" : ""}
                {p.lastUsedAt
                  ? ` · last used ${new Date(p.lastUsedAt).toLocaleDateString()}`
                  : " · never used"}
              </span>
              <Button variant="ghost" onClick={() => void removePasskey(p.id)} disabled={!canAct}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-4 text-sm text-muted-foreground">
          You haven&apos;t added any passkeys yet.
        </p>
      )}

      <div className="mb-3">
        <Label htmlFor="passkey_stepup">Confirm it&apos;s you</Label>
        <Input
          id="passkey_stepup"
          type="password"
          autoComplete="current-password"
          placeholder="Current password or 6-digit code"
          value={stepUp}
          onChange={(e) => setStepUp(e.target.value)}
        />
      </div>

      <Button onClick={() => void addPasskey()} disabled={!canAct}>
        {busy ? "Follow your browser…" : "Add a passkey"}
      </Button>
    </AccountSectionCard>
  );
}
