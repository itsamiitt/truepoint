// PasswordSection.tsx — change the sign-in password (step-up: current password required). SSR, no-JS friendly,
// WCAG 2.2 AA: every input has an associated <Label htmlFor>, errors are announced via role="alert" and tied
// to the form, and the new-password rules are stated up-front (not only on error). Copy is plain + localizable.
import { AccountSectionCard } from "@/shared/AccountShell";
import { SubmitButton } from "@/shared/SubmitButton";
import { PASSWORD_MIN_LENGTH } from "@leadwolf/auth";
import { Alert, Input, Label } from "@leadwolf/ui";
import { changePassword } from "./actions";
import type { StatusMessage } from "./status";

// Map the neutral ?password=<status> back into a localizable message. `reauth` and the policy reasons all
// resolve here so the action never has to put a sensitive reason in the URL.
function passwordStatusMessage(status: string | undefined): StatusMessage | null {
  switch (status) {
    case "changed":
      return {
        tone: "ok",
        text: "Your password has been changed. Other sessions were signed out.",
      };
    case "reauth":
      return { tone: "error", text: "That current password wasn't correct. Please try again." };
    case "mismatch":
      return { tone: "error", text: "The new passwords don't match." };
    case "too_short":
      return {
        tone: "error",
        text: `Choose a password with at least ${PASSWORD_MIN_LENGTH} characters.`,
      };
    case "too_long":
      return { tone: "error", text: "That password is too long. Choose a shorter one." };
    case "breached":
      return {
        tone: "error",
        text: "That password has appeared in a known data breach. Choose a different one.",
      };
    default:
      return null;
  }
}

export function PasswordSection({
  hasPassword,
  status,
}: {
  hasPassword: boolean;
  status?: string;
}) {
  const msg = passwordStatusMessage(status);
  return (
    <AccountSectionCard
      id="password"
      title="Password"
      description="Change the password used to sign in to TruePoint."
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

      {hasPassword ? (
        <form action={changePassword} noValidate className="flex flex-col gap-4">
          <div>
            <Label htmlFor="current_password">Current password</Label>
            <Input
              id="current_password"
              name="current_password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
          <div>
            <Label htmlFor="new_password">New password</Label>
            <Input
              id="new_password"
              name="new_password"
              type="password"
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
              required
              aria-describedby="new_password_hint"
            />
            <p id="new_password_hint" className="mt-1 text-[12px] text-[var(--tp-ink-3)]">
              At least {PASSWORD_MIN_LENGTH} characters. Avoid passwords used elsewhere.
            </p>
          </div>
          <div>
            <Label htmlFor="confirm_password">Confirm new password</Label>
            <Input
              id="confirm_password"
              name="confirm_password"
              type="password"
              autoComplete="new-password"
              required
            />
          </div>
          <div className="max-w-[220px]">
            <SubmitButton>Change password</SubmitButton>
          </div>
        </form>
      ) : (
        <p className="text-sm text-[var(--tp-ink-3)]">
          Your account signs in without a password (single sign-on or a passkey). There is no password to
          change here.
        </p>
      )}
    </AccountSectionCard>
  );
}
