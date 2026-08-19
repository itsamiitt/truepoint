// entry.tsx — the design-sync entry for apps/auth, the identity app.
//
// SCOPE LIMIT, stated plainly: every route page in apps/auth (login, signup, forgot, reset, magic, mfa,
// sso, org, workspace, verify) is an `async` React Server Component. An async component cannot be rendered
// by `createRoot`, which is how every preview card renders — so those pages cannot ship as cards, and no
// amount of stubbing changes that. It is a property of the component model, not a missing fixture.
//
// What ships instead is the layer those pages are BUILT from — the shells, the brand lockup, the form
// controls, and the four account-security sections, all client-renderable and all taking their data as
// props. The screens themselves are reconstructed in `.design-sync/previews/` as compositions of exactly
// these parts, so the design agent still gets "this is what the login screen looks like" — assembled from
// the real components rather than from a screenshot.

// The two shells every auth surface is framed by, and the brand mark they share.
export { AuthShell } from "../../../apps/auth/src/shared/AuthShell";
export { AccountShell } from "../../../apps/auth/src/shared/AccountShell";
export { BrandLockup } from "../../../apps/auth/src/shared/BrandLockup";

// Form controls.
export { SubmitButton } from "../../../apps/auth/src/shared/SubmitButton";
export { OtpInput } from "../../../apps/auth/src/shared/OtpInput";
export { TurnstileWidget } from "../../../apps/auth/src/shared/TurnstileWidget";

// The account-security surfaces. Each takes its data as props, so a card supplies fixtures directly —
// no network seam to stub beyond the server actions their forms post to.
export { MfaSection } from "../../../apps/auth/src/app/account/security/MfaSection";
export { PasskeySection } from "../../../apps/auth/src/app/account/security/PasskeySection";
export { SessionsSection } from "../../../apps/auth/src/app/account/security/SessionsSection";
export { HistorySection } from "../../../apps/auth/src/app/account/security/HistorySection";

// Passkey sign-in — the one interactive step of the MFA challenge that is a client component.
export { PasskeySignIn } from "../../../apps/auth/src/app/mfa/PasskeySignIn";
