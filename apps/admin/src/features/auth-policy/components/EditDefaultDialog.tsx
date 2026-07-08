// EditDefaultDialog.tsx — set ONE platform-DEFAULT auth policy key. The value input adapts to the selected key
// (enum → select, boolean → true/false select, timeout → number, method/CIDR lists → textarea) and sends the
// correctly-TYPED value. The SERVER is the real guard: validatePolicyWrite validates the value's shape and
// rejects anything below the security floor (422 unknown_key/invalid_value, 403 policy_below_floor) — surfaced
// here as a toast. super_admin-gated by the route (requireStaffRole) + the render-gate; the write is audited
// server-side (withPlatformTx → platform_audit_log). Mirrors the retention EditPolicyDialog.
"use client";

import {
  Dialog,
  FieldGroup,
  TpButton,
  TpInput,
  TpSelect,
  TpTextarea,
  useToast,
} from "@leadwolf/ui";
import { useState } from "react";
import { setPlatformDefault } from "../api";

type Kind = "enum" | "boolean" | "number" | "stringList";
interface KeySpec {
  label: string;
  kind: Kind;
  options?: string[];
  placeholder?: string;
  help?: string;
}

// The tenant-editable policy keys, each with its value shape. Keep in sync with @leadwolf/types authPolicySchema;
// the server re-validates regardless, so a drift here is a UX nicety, never a security gap.
const KEY_SPECS: Record<string, KeySpec> = {
  mfa_enforcement: {
    label: "MFA enforcement",
    kind: "enum",
    options: ["off", "optional", "required"],
    help: "The minimum MFA posture every org inherits; an org may only make it stricter.",
  },
  require_sso: { label: "Require SSO", kind: "boolean" },
  disable_social: { label: "Disable social login", kind: "boolean" },
  allowed_methods: {
    label: "Allowed methods",
    kind: "stringList",
    placeholder: "password, oauth, magic_link, sso, passkey",
    help: "Comma- or newline-separated. Empty = no restriction.",
  },
  ip_allowlist: {
    label: "IP allowlist (CIDR)",
    kind: "stringList",
    placeholder: "10.0.0.0/8",
    help: "Comma- or newline-separated CIDR blocks. Empty = no restriction.",
  },
  session_timeout_seconds: {
    label: "Session timeout (seconds)",
    kind: "number",
    placeholder: "e.g. 28800",
  },
  idle_timeout_seconds: {
    label: "Idle timeout (seconds)",
    kind: "number",
    placeholder: "e.g. 3600",
  },
};
const KEYS = Object.keys(KEY_SPECS);

/** The raw-input string a freshly-selected key starts at (so an enum/boolean is never submitted empty). */
function defaultRaw(spec: KeySpec): string {
  if (spec.kind === "enum") return spec.options?.[0] ?? "";
  if (spec.kind === "boolean") return "false";
  return "";
}

/** Convert the raw input to the TYPED value the API + server schema expect. */
function buildValue(spec: KeySpec, raw: string): unknown {
  const t = raw.trim();
  switch (spec.kind) {
    case "enum":
      return t;
    case "boolean":
      return t === "true";
    case "number":
      return Number.parseInt(t, 10);
    case "stringList":
      return t
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
  }
}

export function EditDefaultDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const toast = useToast();
  const firstKey = KEYS[0] ?? "mfa_enforcement";
  const [key, setKey] = useState<string>(firstKey);
  const [raw, setRaw] = useState<string>(defaultRaw(KEY_SPECS[firstKey] as KeySpec));
  const [busy, setBusy] = useState(false);
  const spec = KEY_SPECS[key] as KeySpec;

  function onKeyChange(next: string) {
    setKey(next);
    setRaw(defaultRaw(KEY_SPECS[next] as KeySpec));
  }

  async function save() {
    if (spec.kind === "number") {
      const n = Number.parseInt(raw.trim(), 10);
      if (!Number.isInteger(n) || n < 1) {
        toast.error("Enter a positive whole number of seconds");
        return;
      }
    }
    setBusy(true);
    try {
      await setPlatformDefault(key, buildValue(spec, raw));
      toast.success(`Platform default “${key}” saved`);
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the platform default");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={() => !busy && onClose()}
      title="Set a platform default"
      description="Sets ONE platform-wide policy key. Every org inherits it and may only tighten it — the server rejects any value below the security floor."
      maxWidth={520}
      footer={
        <>
          <TpButton variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </TpButton>
          <TpButton variant="primary" loading={busy} onClick={() => void save()}>
            Save default
          </TpButton>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <FieldGroup label="Policy key" htmlFor="pp-key">
          <TpSelect id="pp-key" value={key} onChange={(e) => onKeyChange(e.currentTarget.value)}>
            {KEYS.map((k) => (
              <option key={k} value={k}>
                {(KEY_SPECS[k] as KeySpec).label}
              </option>
            ))}
          </TpSelect>
        </FieldGroup>

        <FieldGroup label={spec.label} htmlFor="pp-val">
          {spec.kind === "enum" ? (
            <TpSelect id="pp-val" value={raw} onChange={(e) => setRaw(e.currentTarget.value)}>
              {spec.options?.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </TpSelect>
          ) : spec.kind === "boolean" ? (
            <TpSelect id="pp-val" value={raw} onChange={(e) => setRaw(e.currentTarget.value)}>
              <option value="false">false</option>
              <option value="true">true</option>
            </TpSelect>
          ) : spec.kind === "stringList" ? (
            <TpTextarea
              id="pp-val"
              value={raw}
              placeholder={spec.placeholder}
              onChange={(e) => setRaw(e.currentTarget.value)}
            />
          ) : (
            <TpInput
              id="pp-val"
              type="number"
              min={1}
              value={raw}
              placeholder={spec.placeholder}
              onChange={(e) => setRaw(e.currentTarget.value)}
            />
          )}
        </FieldGroup>

        {spec.help ? (
          <p style={{ margin: 0, fontSize: 12, color: "var(--tp-ink-3)" }}>{spec.help}</p>
        ) : null}
      </div>
    </Dialog>
  );
}
