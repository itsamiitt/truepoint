// AuthShell — the centred card every auth screen is built in: brand lockup, title, optional subtitle,
// the screen's own body, and an optional footer line.
//
// These cells are ALSO the screens. The route pages that normally compose them (login, forgot, reset,
// magic-link, MFA) are async Server Components and cannot be rendered by a preview — see the scope note in
// .design-sync/apps/auth/entry.tsx. So the screens are reconstructed here from the real shell and the real
// controls, which is what the design agent needs to see and what an engineer would actually assemble.
import { AuthShell, Button, Input, Label, OtpInput, SubmitButton } from "@leadwolf/ui";
import { ground } from "./_authFixtures";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ ...ground, height: 640 }}>{children}</div>
);

/** Sign-in: the identifier + password step, with the recovery and sign-up routes in the footer. */
export const SignIn = () => (
  <Frame>
    <AuthShell
      title="Sign in"
      subtitle="Use your work email to continue to TruePoint."
      footer={
        <>
          <a className="underline underline-offset-2" href="/forgot">
            Forgot your password?
          </a>
          {" · "}
          <a className="underline underline-offset-2" href="/signup">
            Create an account
          </a>
        </>
      }
    >
      <form className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="email">Work email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" defaultValue="" placeholder="you@company.com" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="password">Password</Label>
          <Input id="password" name="password" type="password" autoComplete="current-password" defaultValue="" />
        </div>
        <SubmitButton>Continue</SubmitButton>
      </form>
    </AuthShell>
  </Frame>
);

/** Password recovery: one field, one action, and a way back — the whole screen. */
export const ForgotPassword = () => (
  <Frame>
    <AuthShell
      title="Reset your password"
      subtitle="We’ll email you a link to choose a new one."
      footer={
        <a className="underline underline-offset-2" href="/login">
          Back to sign in
        </a>
      }
    >
      <form className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="reset-email">Work email</Label>
          <Input id="reset-email" name="email" type="email" autoComplete="email" defaultValue="" placeholder="you@company.com" />
        </div>
        <SubmitButton>Send reset link</SubmitButton>
      </form>
    </AuthShell>
  </Frame>
);

/** The MFA challenge: the 6-digit code field, which auto-submits on the sixth digit. */
export const TwoFactor = () => (
  <Frame>
    <AuthShell
      title="Two-factor authentication"
      subtitle="Enter the 6-digit code from your authenticator app."
      footer={
        <a className="underline underline-offset-2" href="/mfa?recovery=1">
          Use a recovery code instead
        </a>
      }
    >
      <form className="grid gap-4">
        <OtpInput />
        <SubmitButton>Verify</SubmitButton>
      </form>
    </AuthShell>
  </Frame>
);

/** A terminal, no-input state: the magic link has been sent and the screen is only telling the user so. */
export const LinkSent = () => (
  <Frame>
    <AuthShell
      title="Check your email"
      subtitle="We sent a sign-in link to priya.raghavan@northwind.example. It expires in 15 minutes."
      footer={
        <a className="underline underline-offset-2" href="/login">
          Use a different email
        </a>
      }
    >
      {/* outline, not "secondary" — Button's variants are default | outline | ghost | link, and an
          unknown name silently falls through to the base classes with no surface at all. */}
      <Button variant="outline" size="full" type="button">
        Resend link
      </Button>
    </AuthShell>
  </Frame>
);
