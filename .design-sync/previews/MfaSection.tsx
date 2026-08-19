// MfaSection — the two-factor block of the security surface: registered methods, the step-up field the
// destructive actions require, recovery-code count and regeneration.
//
// The variant axis is the account's factor posture, which changes both what the section offers and how it
// asks the user to step up: a password account steps up with its password, an SSO/passkey-only account has
// no password to step up with and is asked for a current authenticator code instead (and, with no factors
// at all, is pointed at the reset flow to set one).
import { AccountShell, MfaSection } from "@leadwolf/ui";
import { MFA_METHODS, ground } from "./_authFixtures";

const Frame = ({ children, height = 700 }: { children: React.ReactNode; height?: number }) => (
  <div style={{ ...ground, height }}>
    <AccountShell title="Security" sections={[]}>
      {children}
    </AccountShell>
  </div>
);

/** A password account with both factor types registered and recovery codes in hand. */
export const Registered = () => (
  <Frame>
    <MfaSection methods={MFA_METHODS} hasPassword setPasswordHref="/reset" recoveryCodesRemaining={8} />
  </Frame>
);

/** No factors yet — the enrolment call to action, which is what most accounts see first. */
export const NoFactors = () => (
  <Frame height={560}>
    <MfaSection methods={[]} hasPassword setPasswordHref="/reset" recoveryCodesRemaining={0} />
  </Frame>
);

/** SSO / passkey-only: no password to step up with, so the step-up asks for an authenticator code. */
export const NoPassword = () => (
  <Frame>
    <MfaSection
      methods={MFA_METHODS.slice(0, 1)}
      hasPassword={false}
      setPasswordHref="/reset"
      recoveryCodesRemaining={3}
    />
  </Frame>
);

/** Recovery codes nearly spent — the count is the signal to regenerate. */
export const LowRecoveryCodes = () => (
  <Frame>
    <MfaSection methods={MFA_METHODS} hasPassword setPasswordHref="/reset" recoveryCodesRemaining={1} />
  </Frame>
);
