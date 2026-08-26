// MfaSection.tsx — two-step (MFA) management: the REAL enrolled-method list (replacing the app-side hard-coded
// placeholder), TOTP enrollment (step-up), per-method disable (step-up), and recovery-code regeneration
// (step-up). SSR, no-JS friendly, WCAG 2.2 AA (labelled inputs, role="alert" errors, clear status copy).
// The QR/secret display + "show recovery codes once" render on the dedicated /account/security/enroll screen.
import { AccountSectionCard } from "@/shared/AccountShell";
import { SubmitButton } from "@/shared/SubmitButton";
import styles from "@/shared/auth.module.css";
import { Alert, Badge, Button, Input, Label, StatusBadge } from "@leadwolf/ui";
import { disableMfaMethod, regenerateRecoveryCodes, startTotpEnroll } from "./actions";
import type { MfaMethodView } from "./data";
import type { StatusMessage } from "./status";
import { canStepUp } from "./stepUpEligibility";

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
  hasPassword,
  setPasswordHref,
  recoveryCodesRemaining,
  status,
}: {
  methods: MfaMethodView[];
  /** Whether the user has a password to step up with. False for SSO/passkey-only users, who step up with a
   * current authenticator (TOTP) code instead — the step-up field then asks for the code, not a password. */
  hasPassword: boolean;
  /** Where to send a passwordless-and-factorless user to set a password (the reset flow) — AUTH-069. */
  setPasswordHref: string;
  recoveryCodesRemaining: number;
  status?: string;
}) {
  const verified = methods.filter((m) => m.verifiedAt);
  const hasTotp = verified.some((m) => m.type === "totp");
  // AUTH-069: enrolling the first factor is itself step-up-gated. A passwordless user with no verified factor
  // cannot step up, so we must NOT show an enroll form whose credential field asks for a code they can't have.
  const canEnroll = canStepUp({ hasPassword, hasVerifiedTotp: hasTotp });
  const msg = mfaStatusMessage(status);

  // Step-up credential the forms below collect: a password when the user has one, else a current TOTP code
  // (verifyStepUp accepts EITHER). The field name stays `current_password` — that is just the FormData key the
  // server action reads; the visible label/placeholder/autocomplete switch so the prompt matches what's asked.
  const stepUpLabel = hasPassword ? "Current password" : "Authenticator code";
  const stepUpAutoComplete = hasPassword ? "current-password" : "one-time-code";
  const stepUpType = hasPassword ? "password" : "text";
  const stepUpInputMode = hasPassword ? undefined : "numeric";

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
          className={styles.spaced}
        >
          {msg.text}
        </Alert>
      ) : null}

      {/* Enrolled methods */}
      <ul
        style={{
          marginBottom: "var(--tp-space-5)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--tp-space-2)",
        }}
        aria-label="Enrolled two-step methods"
      >
        {verified.length === 0 ? (
          <li style={{ fontSize: "var(--tp-text-label)", color: "var(--tp-ink-3)" }}>
            No two-step method is set up yet.
          </li>
        ) : (
          verified.map((m) => (
            <li
              key={m.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "var(--tp-space-3)",
                padding: "var(--tp-space-2) var(--tp-space-3)",
                border: "1px solid var(--tp-hairline-2)",
                borderRadius: "var(--radius)",
              }}
            >
              <span style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: "var(--tp-text-label)", fontWeight: 500 }}>
                  {TYPE_LABELS[m.type] ?? m.type}
                </span>
                <span style={{ fontSize: "var(--tp-text-caption)", color: "var(--tp-ink-3)" }}>
                  Added {m.createdAt.toLocaleDateString()}
                  {m.lastUsedAt ? ` · last used ${m.lastUsedAt.toLocaleDateString()}` : ""}
                </span>
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: "var(--tp-space-2)" }}>
                <StatusBadge tone="success">On</StatusBadge>
                {/* Disable requires step-up — the current password is collected inline. */}
                <form
                  action={disableMfaMethod}
                  style={{ display: "flex", alignItems: "center", gap: "var(--tp-space-2)" }}
                >
                  <input type="hidden" name="method_id" value={m.id} />
                  <Label htmlFor={`disable_pw_${m.id}`} className={styles.srOnly}>
                    {stepUpLabel} to remove this method
                  </Label>
                  <Input
                    id={`disable_pw_${m.id}`}
                    name="current_password"
                    type={stepUpType}
                    inputMode={stepUpInputMode}
                    autoComplete={stepUpAutoComplete}
                    placeholder={stepUpLabel}
                    required
                    // Not a button and not a media slot: this is the step-up field inline in the method ROW,
                    // narrowed from the DS field's width:100% so it fits beside "Remove". The `height: 36` that
                    // used to sit here was dead weight — .tp-ui-field is already 36px — and only made the pair
                    // look like a bespoke control. 160px is off the spacing scale by design: it is a field
                    // width chosen for the row, not a token-able gap.
                    style={{ width: 160 }}
                  />
                  <SubmitButton>Remove</SubmitButton>
                </form>
              </span>
            </li>
          ))
        )}
      </ul>

      {/* Enroll TOTP (step-up). A passwordless user with no factor yet cannot step up to enroll a FIRST factor
          (AUTH-069) — so instead of an unusable form we point them at the one path that works: set a password. */}
      {!hasTotp ? (
        canEnroll ? (
          <form
            action={startTotpEnroll}
            noValidate
            style={{
              marginBottom: "var(--tp-space-6)",
              display: "flex",
              flexDirection: "column",
              gap: "var(--tp-space-3)",
            }}
          >
            <div>
              <span style={{ fontSize: "var(--tp-text-label)", fontWeight: 500 }}>
                Set up an authenticator app
              </span>
              <p
                style={{
                  marginTop: "var(--tp-space-1)",
                  fontSize: "var(--tp-text-caption)",
                  color: "var(--tp-ink-3)",
                }}
              >
                You'll scan a QR code, confirm a code, and save one-time recovery codes.
              </p>
            </div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: "var(--tp-space-2)" }}>
              <div style={{ flex: 1, minWidth: 0, maxWidth: 220 }}>
                <Label htmlFor="enroll_current_password">{stepUpLabel}</Label>
                <Input
                  id="enroll_current_password"
                  name="current_password"
                  type={stepUpType}
                  inputMode={stepUpInputMode}
                  autoComplete={stepUpAutoComplete}
                  required
                />
              </div>
              <SubmitButton>Begin setup</SubmitButton>
            </div>
          </form>
        ) : (
          <div
            style={{
              marginBottom: "var(--tp-space-6)",
              display: "flex",
              flexDirection: "column",
              gap: "var(--tp-space-3)",
            }}
          >
            <div>
              <span style={{ fontSize: "var(--tp-text-label)", fontWeight: 500 }}>
                Set up an authenticator app
              </span>
              <p
                style={{
                  marginTop: "var(--tp-space-1)",
                  fontSize: "var(--tp-text-caption)",
                  color: "var(--tp-ink-3)",
                }}
              >
                Your account signs in without a password, so there's no credential to confirm setup
                with yet. Set a password first — you can still sign in with a link too — then add an
                authenticator here.
              </p>
            </div>
            {/* The DS secondary button, worn by an <a>. `asChild` merges the button's classes onto the anchor,
                so this is the real thing rather than auth.module.css's hand-rolled .buttonLink lookalike (now
                deleted). Button is a client component, but rendering one from an RSC is fine — its child here
                is a plain host element, which serialises across the boundary, and it SSRs to a styled <a> that
                needs no JavaScript to be clickable. Default size, not `sm`: .buttonLink was 36px/14px, which
                is the DS default; `sm` is 30px/13px and would shrink this CTA. alignSelf replaces its
                `width: fit-content` — this sits in a flex COLUMN, whose default align-items:stretch would
                otherwise pull the button across the whole card. */}
            <Button variant="outline" asChild style={{ alignSelf: "flex-start" }}>
              <a href={setPasswordHref}>Set a password</a>
            </Button>
          </div>
        )
      ) : null}

      {/* Recovery codes — only relevant once a real factor is enrolled (they are a fallback FOR a factor). */}
      {verified.length > 0 ? (
        <div
          style={{ borderTop: "1px solid var(--tp-hairline-2)", paddingTop: "var(--tp-space-4)" }}
        >
          <div
            style={{
              marginBottom: "var(--tp-space-2)",
              display: "flex",
              alignItems: "center",
              gap: "var(--tp-space-2)",
            }}
          >
            <span style={{ fontSize: "var(--tp-text-label)", fontWeight: 500 }}>
              Recovery codes
            </span>
            <Badge>{recoveryCodesRemaining} remaining</Badge>
          </div>
          <p
            style={{
              marginBottom: "var(--tp-space-3)",
              fontSize: "var(--tp-text-caption)",
              color: "var(--tp-ink-3)",
            }}
          >
            One-time codes to sign in if you lose your authenticator. Regenerating replaces any
            existing codes.
          </p>
          <form
            action={regenerateRecoveryCodes}
            noValidate
            style={{ display: "flex", alignItems: "flex-end", gap: "var(--tp-space-2)" }}
          >
            <div style={{ flex: 1, minWidth: 0, maxWidth: 220 }}>
              <Label htmlFor="regen_current_password">{stepUpLabel}</Label>
              <Input
                id="regen_current_password"
                name="current_password"
                type={stepUpType}
                inputMode={stepUpInputMode}
                autoComplete={stepUpAutoComplete}
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
