// index.ts — public barrel for the TruePoint transactional auth-email templates. Each template returns a
// ready-to-send { subject, html, text } that the call sites (signup / verify / magic / forgot) spread into
// sendAuthEmail. Add new auth-email templates here.
export { BRAND, type RenderedEmail } from "./layout.ts";
export { type MagicLinkInput, magicLinkEmail } from "./magicLink.ts";
export { type MfaChangedInput, type MfaChangeKind, mfaChangedEmail } from "./mfaChanged.ts";
export { type NewSignInInput, newSignInEmail } from "./newSignIn.ts";
export {
  type PasskeyChangedInput,
  type PasskeyChangeKind,
  passkeyChangedEmail,
} from "./passkeyChanged.ts";
export { type PasswordChangedInput, passwordChangedEmail } from "./passwordChanged.ts";
export { type PasswordResetInput, passwordResetEmail } from "./passwordReset.ts";
export { type VerificationCodeInput, verificationCodeEmail } from "./verificationCode.ts";
export { type LoginCodeInput, loginCodeEmail } from "./loginCode.ts";
