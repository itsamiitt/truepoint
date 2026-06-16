// index.ts — public barrel for the TruePoint transactional auth-email templates. Each template returns a
// ready-to-send { subject, html, text } that the call sites (signup / verify / magic / forgot) spread into
// sendAuthEmail. Add new auth-email templates here.
export { BRAND, type RenderedEmail } from "./layout.ts";
export { type MagicLinkInput, magicLinkEmail } from "./magicLink.ts";
export { type PasswordResetInput, passwordResetEmail } from "./passwordReset.ts";
export { type VerificationCodeInput, verificationCodeEmail } from "./verificationCode.ts";
