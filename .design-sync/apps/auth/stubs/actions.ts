// stubs/actions.ts — the auth app's Next server actions, replaced by inert no-ops.
//
// The security and MFA sections take these as `<form action={…}>` props. The real modules are "use server"
// files that reach straight into @leadwolf/db and @leadwolf/auth — server-only code that cannot be bundled
// for a browser preview, and that must never run against a real session from a design card anyway.
//
// One stub serves both `./actions` modules (the account/security one and the mfa one): the manifest matches
// on the specifier via aliasPatterns, and the union of names below covers what either importer destructures.
// A missing name would surface as a loud "No matching export" at build time, never as a silent undefined.
//
// Each returns the shape its caller expects from a form submission and does nothing else — a preview card
// renders the form's resting state; it never posts.

/** The status envelope the security sections render after a submit. */
export interface StubResult {
  ok: boolean;
  message?: string;
}

const inert = async (): Promise<StubResult> => ({ ok: true });

// account/security/actions
export const changePassword = inert;
export const disableMfaMethod = inert;
export const regenerateRecoveryCodes = inert;
export const startTotpEnroll = inert;
export const revokeAllOtherSessions = inert;
export const revokeOwnSession = inert;

// mfa/actions
export const submitMfaPasskey = inert;
