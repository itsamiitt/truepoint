// PasskeySection.tsx — account-security UI for passkeys (AUTH-024): list the user's registered passkeys and add
// a new one via the WebAuthn registration ceremony (@simplewebauthn/browser handles the ArrayBuffer↔base64url
// encoding + the navigator.credentials.create prompt). Rendered only when WEBAUTHN_ENABLED (the page gates it),
// and every route it calls 404s when off, so this is fully inert until passkeys are turned on. A cancelled
// browser prompt is a soft notice, not an error.
"use client";

import { AUTH_BASE_PATH } from "@/lib/authUrl";
import { AccountSectionCard } from "@/shared/AccountShell";
import { Alert, Button } from "@leadwolf/ui";
import {
  type PublicKeyCredentialCreationOptionsJSON,
  startRegistration,
} from "@simplewebauthn/browser";
import { useCallback, useEffect, useState } from "react";

const BASE = `${AUTH_BASE_PATH}/account/security/passkeys`;

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
        body: JSON.stringify({ response: attResp, label: navigator.platform || "Passkey" }),
      });
      const { verified } = (await vRes.json()) as { verified?: boolean };
      if (!verified) throw new Error("verify");
      setMsg({ ok: true, text: "Passkey added — you can use it to sign in." });
      await reload();
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

  async function removePasskey(id: string): Promise<void> {
    await fetch(`${BASE}/${id}`, { method: "DELETE" });
    await reload();
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
              <Button variant="ghost" onClick={() => void removePasskey(p.id)}>
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

      <Button onClick={() => void addPasskey()} disabled={busy}>
        {busy ? "Follow your browser…" : "Add a passkey"}
      </Button>
    </AccountSectionCard>
  );
}
