// OtpInput.tsx — the 6-digit MFA code input. Progressive enhancement: with JS it auto-submits the form on
// the 6th digit (mission requirement); without JS the screen's Verify button still works. Bundled 'self'
// script — no inline JS, so it satisfies the auth origin's nonce-CSP.
"use client";

export function OtpInput() {
  return (
    <input
      className="auth-input"
      id="code"
      name="code"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]*"
      maxLength={6}
      required
      // biome-ignore lint/a11y/noAutofocus: the OTP step focuses its single input by design
      autoFocus
      aria-label="6-digit verification code"
      onChange={(e) => {
        const v = e.currentTarget.value.replace(/\D/g, "").slice(0, 6);
        e.currentTarget.value = v;
        if (v.length === 6) e.currentTarget.form?.requestSubmit();
      }}
    />
  );
}
