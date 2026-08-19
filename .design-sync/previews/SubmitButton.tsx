// SubmitButton — the auth forms' submit control. Progressive enhancement: with JS it reflects the server
// action's pending state through useFormStatus (spinner, disabled, aria-busy) so a redirect round trip is
// visible rather than feeling frozen; with JS off it degrades to a plain native submit button.
//
// The pending state cannot be shown statically — useFormStatus reports pending only while a real form
// action is in flight, and a preview posts nothing. What the cells show is the resting state, which is what
// every screen renders until the moment of submit.
import { SubmitButton } from "@leadwolf/ui";

const form: React.CSSProperties = {
  display: "grid",
  gap: 12,
  maxWidth: 360,
  padding: 20,
  background: "var(--tp-surface, #fff)",
  border: "1px solid var(--tp-hairline-2, #eceef1)",
  borderRadius: 10,
};

/** Full-width, as every auth form renders it. */
export const Resting = () => (
  <form style={form}>
    <SubmitButton>Continue</SubmitButton>
  </form>
);

/** The label carries the screen's action — the button itself never varies. */
export const Labels = () => (
  <form style={form}>
    <SubmitButton>Sign in</SubmitButton>
    <SubmitButton>Send reset link</SubmitButton>
    <SubmitButton>Verify</SubmitButton>
  </form>
);
