// MfaSection.tsx — two-step (MFA) management: the REAL enrolled-method list (replacing the app-side hard-coded
// placeholder), TOTP enrollment (step-up), per-method disable (step-up), and recovery-code regeneration
// (step-up). SSR, no-JS friendly, WCAG 2.2 AA (labelled inputs, role="alert" errors, clear status copy).
// The QR/secret display + "show recovery codes once" render on the dedicated /account/security/enroll screen.
import { AccountSectionCard } from "@/shared/AccountShell";
import { SubmitButton } from "@/shared/SubmitButton";
import { Alert, Badge, Input, Label, StatusBadge } from "@leadwolf/ui";
import { disableMfaMethod, regenerateRecoveryCodes, startTotpEnroll } from "./actions";
import type { MfaMethodView } from "./data";
import type { StatusMessage } from "./status";

function mfaStatusMessage(status: string | undefined): StatusMessage | null {
  switch (status) {
    case "reauth":
      return { tone: "error", text: "That current password wasn't correct. Please try again." };
    case "disabled":
      return { tone: "ok", text: "That two-step method was removed." };
    case "notfound":
      return { tone: "error", text: "That method is no longer available." };
    case "expired":
      return { tone: "error", text: "Enrollment timed out. Please start again." };
    default:
      return null;
  }
}

const TYPE_LABELS: Record<string, string> = {
  totp: "Authenticator app (TOTP)",
  webauthn: "Passkey / security key",
  sms: "SMS code",
  email: "Email code",
};

export function MfaSection({
  methods,
  recoveryCodesRemaining,
  status,
}: {
  methods: MfaMethodView[];
  recoveryCodesRemaining: number;
  status?: string;
}) {
  const verified = methods.filter((m) => m.verifiedAt);
  const hasTotp = verified.some((m) => m.type === "totp");
  const msg = mfaStatusMessage(status);

  return (
    <AccountSectionCard
      id="mfa"
      title="Two-step verification"
      description="Add a second factor so a password alone can't unlock your account."
    >
      {msg ? (
        <Alert
          variant={msg.tone === "ok" ? "default" : "destructive"}
          role={msg.tone === "ok" ? "status" : "alert"}
          className="mb-4"
        >
          {msg.text}
        </Alert>
      ) : null}

      {/* Enrolled methods */}
      <ul className="mb-5 flex flex-col gap-2" aria-label="Enrolled two-step methods">
        {verified.length === 0 ? (
          <li className="text-sm text-[var(--tp-ink-3)]">No two-step method is set up yet.</li>
        ) : (
          verified.map((m) => (
            <li
              key={m.id}
              className="flex items-center justify-between gap-3 rounded-[var(--radius)] border border-[var(--tp-hairline-2)] px-3 py-2"
            >
              <span className="flex flex-col">
                <span className="text-sm font-medium">{TYPE_LABELS[m.type] ?? m.type}</span>
                <span className="text-[12px] text-[var(--tp-ink-3)]">
                  Added {m.createdAt.toLocaleDateString()}
                  {m.lastUsedAt ? ` · last used ${m.lastUsedAt.toLocaleDateString()}` : ""}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <StatusBadge tone="success">On</StatusBadge>
                {/* Disable requires step-up — the current password is collected inline. */}
                <form action={disableMfaMethod} className="flex items-center gap-2">
                  <input type="hidden" name="method_id" value={m.id} />
                  <Label htmlFor={`disable_pw_${m.id}`} className="sr-only">
                    Current password to remove this method
                  </Label>
                  <Input
                    id={`disable_pw_${m.id}`}
                    name="current_password"
                    type="password"
                    autoComplete="current-password"
                    placeholder="Current password"
                    required
                    className="h-9 w-[160px]"
                  />
                  <SubmitButton>Remove</SubmitButton>
                </form>
              </span>
            </li>
          ))
        )}
      </ul>

      {/* Enroll TOTP (step-up) */}
      {!hasTotp ? (
        <form action={startTotpEnroll} noValidate className="mb-6 flex flex-col gap-3">
          <div>
            <span className="text-sm font-medium">Set up an authenticator app</span>
            <p className="mt-1 text-[12px] text-[var(--tp-ink-3)]">
              You'll scan a QR code, confirm a code, and save one-time recovery codes.
            </p>
          </div>
          <div className="flex items-end gap-2">
            <div className="flex-1 max-w-[220px]">
              <Label htmlFor="enroll_current_password">Current password</Label>
              <Input
                id="enroll_current_password"
                name="current_password"
                type="password"
                autoComplete="current-password"
                required
              />
            </div>
            <SubmitButton>Begin setup</SubmitButton>
          </div>
        </form>
      ) : null}

      {/* Recovery codes — only relevant once a real factor is enrolled (they are a fallback FOR a factor). */}
      {verified.length > 0 ? (
        <div className="border-t border-[var(--tp-hairline-2)] pt-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-sm font-medium">Recovery codes</span>
            <Badge>{recoveryCodesRemaining} remaining</Badge>
          </div>
          <p className="mb-3 text-[12px] text-[var(--tp-ink-3)]">
            One-time codes to sign in if you lose your authenticator. Regenerating replaces any existing codes.
          </p>
          <form action={regenerateRecoveryCodes} noValidate className="flex items-end gap-2">
            <div className="flex-1 max-w-[220px]">
              <Label htmlFor="regen_current_password">Current password</Label>
              <Input
                id="regen_current_password"
                name="current_password"
                type="password"
                autoComplete="current-password"
                required
              />
            </div>
            <SubmitButton>Regenerate codes</SubmitButton>
          </form>
        </div>
      ) : null}
    </AccountSectionCard>
  );
}
