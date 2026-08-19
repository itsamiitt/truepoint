// PasskeySignIn — the "Use a passkey" option on the MFA step. Fetches an authentication challenge for the
// pending login, runs navigator.credentials.get, and submits the assertion to the server action, which
// verifies it and advances the login exactly as a TOTP code would.
//
// Only the resting state is shown. The busy state ("Follow your browser…") exists solely while a real
// platform credential prompt is open, and a design card must never raise one — clicking would summon the
// OS passkey dialog on the viewer's own machine.
import { OtpInput, PasskeySignIn, SubmitButton } from "@leadwolf/ui";

const form: React.CSSProperties = {
  display: "grid",
  gap: 12,
  maxWidth: 360,
  padding: 20,
  background: "var(--tp-surface, #fff)",
  border: "1px solid var(--tp-hairline-2, #eceef1)",
  borderRadius: 10,
};

/** The button on its own, full width, as the MFA screen places it. */
export const Resting = () => (
  <div style={form}>
    <PasskeySignIn />
  </div>
);

/** In context: the passkey route offered alongside the authenticator-code route it can replace. */
export const AlongsideCode = () => (
  <form style={form}>
    <OtpInput />
    <SubmitButton>Verify</SubmitButton>
    <div style={{ textAlign: "center", fontSize: 12, color: "var(--tp-ink-3, #6b7280)" }}>or</div>
    <PasskeySignIn />
  </form>
);
